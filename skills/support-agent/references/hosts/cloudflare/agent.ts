/**
 * hosts/cloudflare/agent.ts — the Support Agent as a Cloudflare Worker: each
 * task's state in a Durable Object, reported turns in Workers KV.
 *
 * Put it at src/support-agent.ts, beside support-core.ts and the site adapter
 * (imports './support-core' and './site'), with worker.ts as the Worker's `main`
 * and wrangler.toml from this folder. See hosts/cloudflare.md. The main module
 * exports only the handler and the Durable Object class: workerd refuses to
 * start a main module that exports anything else (a string, a number).
 *
 * Status: see hosts/cloudflare.md.
 *
 *   POST /a2a/support                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/support/agent-card.json    its Agent Card, built from the request's origin
 *   GET  /.well-known/agent-card.json    the same card, unless SUPPORT_CARD_WELL_KNOWN is "false"
 *   GET  /a2a/support/healthz            `{ available }`: for the relay's `availability`
 *
 * Host answers:
 * - Where tasks and context live: one Durable Object per task (SupportTask), with
 *   the SDK's task and support-core's context as two keys in its SQLite-backed
 *   storage. Every request for a task, from any Worker instance anywhere,
 *   reaches the same object, which runs one call at a time over strongly
 *   consistent storage: a follow-up always reads the context the turn before it
 *   wrote. NOT Workers KV for these: it is eventually consistent (a write can
 *   take a minute to be seen elsewhere), so a follow-up could read the context
 *   from before the last answer and lose the offer of a person or the thumbs.
 * - Reported questions and turns: Workers KV (SUPPORT_TURNS), `question:<key>`
 *   for a gap question's wording and `turn:<ref>` for a turn, with
 *   `expirationTtl` as the owner's retention. They are written by a report and
 *   read much later by the owner, so eventual consistency costs nothing, and KV
 *   expires keys itself where D1 would need a schema and a cron. Without the
 *   binding and SUPPORT_TURN_REF_SECRET no gap report is sent: the question's
 *   text never is, and there would be no key to name it by.
 * - Gap reports go after the reply, under this request's `ctx.waitUntil`: each
 *   request gets its own executor whose `keepAlive` is that request's
 *   `waitUntil`, since one isolate serves many requests at once.
 * - Secrets: `wrangler secret put` (A2A_RELAY_TOKEN, ANTHROPIC_API_KEY,
 *   SUPPORT_GAP_KEY, SUPPORT_TURN_REF_SECRET); the rest are `vars`. Locally, .dev.vars.
 * - Response time: no wall-clock limit while the relay stays connected; CPU time
 *   is metered, and a turn is mostly waiting. A turn cut off anyway leaves its
 *   task "working"; the next read fails it (`settleStale`, in the object).
 *
 * Needs `compatibility_flags = ["nodejs_compat"]`: @a2a-js/sdk uses `Buffer`,
 * support-core's gapKey and turnRef use node:crypto's createHmac, and example-site.ts
 * imports node:fs/promises and node:path (its file store is never used here).
 */
import { DurableObject } from 'cloudflare:workers';
import Anthropic from '@anthropic-ai/sdk';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import {
  SupportExecutor,
  claudeSupportModel,
  gapSinkFromEnv,
  helpReachable,
  mcpRecords,
  supportAgentCard,
  supportEndpoint,
  type ContextStore,
  type MessagesClient,
  type SupportContext,
  type SupportModel,
  type SupportSite,
  type TurnStore,
} from '../../support-core';
import { exampleSite } from '../../example-site';

const PATH = '/a2a/support';
const CARD = `${PATH}/agent-card.json`;
const WELL_KNOWN = '/.well-known/agent-card.json';
const HEALTH = `${PATH}/healthz`;
export const DEFAULT_SUPPORT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_SUPPORT_REWRITE_MODEL = 'claude-haiku-5-5';
/** The same cap as support-core, enforced here while the body streams in. */
const MAX_BODY = 64_000;
/** Longer than any single turn takes; a task working for longer was cut off. */
export const STALE_WORKING_MS = 90_000;
/** How long a task's object keeps its storage after it was last touched. */
const KEEP_MS = 24 * 60 * 60 * 1000;

export interface Env {
  /** The Durable Object namespace, bound in wrangler.toml. */
  SUPPORT_TASKS: DurableObjectNamespace<SupportTask>;
  /** The KV namespace reported questions and turns go in. Gap reports need it and SUPPORT_TURN_REF_SECRET. */
  SUPPORT_TURNS?: KVNamespace;
  /** Secret. Unset (and no SUPPORT_MODEL_BASE_URL): offered as unavailable. */
  ANTHROPIC_API_KEY?: string;
  /** Secret, shared with the relay (its target's credential). No default: unset, nothing may call the agent. */
  A2A_RELAY_TOKEN?: string;
  /** Var. The site's MCP server, fixed server-side. */
  SUPPORT_MCP_ENDPOINT?: string;
  /** Secret. The site-scoped gap key (scope content_gaps:report). */
  SUPPORT_GAP_KEY?: string;
  /** Var. The provisioning MCP server the gap key reports to. */
  SUPPORT_PROVISIONING_ENDPOINT?: string;
  /** Secret, 32+ characters. Question keys and turn references on, with SUPPORT_TURNS bound. Unset: no gap or close reports. */
  SUPPORT_TURN_REF_SECRET?: string;
  /** Var. How long reported questions and turns are kept, in days: what the owner said. Default 30. */
  SUPPORT_TURN_RETENTION_DAYS?: string;
  SUPPORT_MODEL?: string;
  SUPPORT_REWRITE_MODEL?: string;
  SUPPORT_MODEL_BASE_URL?: string;
  /** Var. "false" when another agent already serves /.well-known/agent-card.json. */
  SUPPORT_CARD_WELL_KNOWN?: string;
  /** Present when this Worker also serves the site's files (Workers static assets). */
  ASSETS?: Fetcher;
}

// ── One Durable Object per task ─────────────────────────────────────────────

/**
 * A task's state: the SDK's task JSON and support-core's context. One call at a time, strongly
 * consistent storage, so every Worker instance sees the context the last turn left.
 */
export class SupportTask extends DurableObject<Env> {
  private get kv() {
    return this.ctx.storage.kv;
  }

  /** Any write pushes the clean-up back: storage is dropped KEEP_MS after the task was last touched. */
  private touch(): void {
    void this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
  }

  loadTask(): unknown {
    return this.kv.get('task') ?? null;
  }
  saveTask(json: unknown): void {
    this.kv.put('task', json);
    this.touch();
  }

  getContext(): SupportContext | null {
    return this.kv.get<SupportContext>('context') ?? null;
  }
  setContext(c: SupportContext): void {
    this.kv.put('context', c);
    this.touch();
  }
  deleteContext(): void {
    this.kv.delete('context');
  }

  /** Fail the task if a cut-off turn left it working, so a resubscribing client learns it is over. */
  settleStale(): void {
    const json = this.kv.get<{ status?: { state?: string; timestamp?: string } }>('task');
    const status = json?.status;
    if (status?.state !== 'TASK_STATE_WORKING' || !status.timestamp) return;
    if (Date.now() - Date.parse(status.timestamp) < STALE_WORKING_MS) return;
    this.kv.put('task', {
      ...json,
      status: {
        state: 'TASK_STATE_FAILED',
        timestamp: new Date().toISOString(),
        message: { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Sorry, that took too long. Please ask again.' }] },
      },
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const taskObject = (env: Env, taskId: string) => env.SUPPORT_TASKS.get(env.SUPPORT_TASKS.idFromName(taskId));

/** The SDK's tasks, in its own JSON, each in its task's object. */
export const taskStore = (env: Env): TaskStore => ({
  async save(task) {
    await taskObject(env, task.id).saveTask(SdkTask.toJSON(task));
  },
  async load(taskId) {
    const json = await taskObject(env, taskId).loadTask();
    return json ? SdkTask.fromJSON(json) : undefined;
  },
  // Each task belongs to one visitor; the relay never forwards ListTasks.
  async list() {
    return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
  },
});

export const contextStore = (env: Env): ContextStore => ({
  get: async (id) => ((await taskObject(env, id).getContext()) as SupportContext | null) ?? null,
  set: async (id, c) => void (await taskObject(env, id).setContext(c)),
  delete: async (id) => void (await taskObject(env, id).deleteContext()),
});

/**
 * Reported turns in KV, under `turn:<ref>`, and gap questions' wording under `question:<question_key>`
 * (`{key, question, firstSeen, lastSeen}`). The owner reads one with
 * `wrangler kv key get --binding SUPPORT_TURNS question:<question_key> --remote` (or `turn:<ref>`).
 */
export const kvTurns = (kv: KVNamespace, retentionDays = 30): TurnStore => {
  // KV's floor for expirationTtl is 60 seconds.
  const expirationTtl = Math.max(60, Math.round(retentionDays * 86_400));
  return {
    async save(ref, turn) {
      await kv.put(`turn:${ref}`, JSON.stringify({ ref, ...turn }), { expirationTtl });
    },
    // Asked again: firstSeen stays, lastSeen and the expiry move on. KV is last-write-wins, which is enough here.
    async saveQuestion(key, q) {
      const held = (await kv.get(`question:${key}`, 'json')) as { firstSeen?: string } | null;
      await kv.put(`question:${key}`, JSON.stringify({ key, question: q.question, firstSeen: held?.firstSeen ?? q.at, lastSeen: q.at }), { expirationTtl });
    },
  };
};

// ── Relay only ──────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Constant-time comparison of the bearer token with the secret. No secret: nothing gets in. */
function fromRelay(env: Env, authorization: string | null): boolean {
  const token = env.A2A_RELAY_TOKEN;
  if (!token) return false;
  const given = encoder.encode(authorization ?? '');
  const expected = encoder.encode(`Bearer ${token}`);
  // timingSafeEqual needs equal lengths; compare something either way so a wrong length costs the same.
  const same = given.byteLength === expected.byteLength;
  return crypto.subtle.timingSafeEqual(same ? given : expected, expected) && same;
}

/** The body as text, refused (null) once it passes `max` bytes — while it streams, not after buffering all of it. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) all.set(c, (at += c.byteLength) - c.byteLength);
  return new TextDecoder().decode(all);
}

/**
 * Stream the endpoint's events to the relay, and keep reading them to the end even if the relay goes
 * away, under `waitUntil`: the turn behind them still saves its context and sends its reports.
 */
function finishEvenIfDisconnected(res: Response, ctx: ExecutionContext): Response {
  if (!res.body || !res.headers.get('content-type')?.startsWith('text/event-stream')) return res;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const reader = res.body.getReader();
  ctx.waitUntil(
    (async () => {
      let connected = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (connected) await writer.write(value).catch(() => (connected = false));
      }
      if (connected) await writer.close().catch(() => {});
    })(),
  );
  return new Response(readable, { status: res.status, headers: res.headers });
}

const refuse = (status: number, message: string) => Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }, { status });

// ── The agent ───────────────────────────────────────────────────────────────

/** EXAMPLE: the card's words. The name matches SupportSite.agentName and the relay's label. */
const card = (origin: string) =>
  supportAgentCard({
    origin,
    path: PATH,
    name: 'Ridgeline Help',
    description: "Answers questions about Ridgeline Air's purifiers from Ridgeline's own help content — FAQs, guides, articles and videos — with a source for every answer.",
    organization: 'Ridgeline Air',
    examples: ['How do I replace the filter on the X200?', 'What does the warranty cover?'],
    tags: ['support', 'help', 'air purifier'],
  });

/** The two models from the Worker's env (no ambient process.env), or null when neither a key nor a proxy is set. */
const claude = (env: Env): SupportModel | null => {
  const baseURL = env.SUPPORT_MODEL_BASE_URL || undefined;
  if (!env.ANTHROPIC_API_KEY && !baseURL) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'proxied', ...(baseURL ? { baseURL } : {}) });
  return claudeSupportModel(client as unknown as MessagesClient, {
    compose: env.SUPPORT_MODEL || DEFAULT_SUPPORT_MODEL,
    rewrite: env.SUPPORT_REWRITE_MODEL || DEFAULT_SUPPORT_REWRITE_MODEL,
    modelHeader: !!baseURL,
  });
};

/**
 * The secret, when it is long enough and there is somewhere to keep questions and turns; else question
 * keys and turn references are off, and with them gap and close reports.
 */
function turnRefs(env: Env): { turns: TurnStore; turnRefSecret: string } | { turns: null } {
  const secret = env.SUPPORT_TURN_REF_SECRET?.trim();
  if (!secret) return { turns: null };
  if (secret.length < 32 || !env.SUPPORT_TURNS) {
    console.error(`[support] question keys and turn references are off, so no gap reports are sent: ${secret.length < 32 ? 'SUPPORT_TURN_REF_SECRET is shorter than 32 characters' : 'no SUPPORT_TURNS KV binding'}.`);
    return { turns: null };
  }
  return { turns: kvTurns(env.SUPPORT_TURNS, Number(env.SUPPORT_TURN_RETENTION_DAYS ?? 30)), turnRefSecret: secret };
}

/** The example site over the Worker's env: every setting passed in, since example-site's defaults read process.env. */
const envSite = (env: Env): SupportSite =>
  exampleSite({
    records: mcpRecords({ endpoint: env.SUPPORT_MCP_ENDPOINT ?? '' }),
    gaps: gapSinkFromEnv(env),
    ...turnRefs(env),
  });

export interface SupportWorkerOptions {
  /** The model; null when none is configured. Defaults to Claude from the env. */
  model?: (env: Env) => SupportModel | null;
  /** The site adapter. Defaults to the example site over the env's settings. */
  site?: (env: Env) => SupportSite;
}

/** The Worker. `export default supportWorker()`; tests pass a scripted model and a stub site. */
export function supportWorker(opts: SupportWorkerOptions = {}): ExportedHandler<Env> {
  // Per isolate: the site (its product-name and corpus caches) and the model. An isolate's env doesn't change.
  let built: { env: Env; site: SupportSite; model: SupportModel | null; reachable: () => Promise<boolean> } | null = null;
  const setup = (env: Env) => {
    if (built?.env !== env) {
      const site = (opts.site ?? envSite)(env);
      built = { env, site, model: (opts.model ?? claude)(env), reachable: helpReachable(site.records) };
    }
    return built;
  };

  return {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      const wellKnown = env.SUPPORT_CARD_WELL_KNOWN !== 'false';

      if (url.pathname === CARD || (wellKnown && url.pathname === WELL_KNOWN)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
        return Response.json(card(url.origin), { headers: { 'Cache-Control': 'public, max-age=300' } });
      }
      if (url.pathname === HEALTH && req.method === 'GET') {
        const { model, reachable } = setup(env);
        return Response.json({ available: model !== null && (await reachable()) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname !== PATH) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });

      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      // Token before body: an unauthenticated caller never gets as far as reading one.
      if (!fromRelay(env, req.headers.get('authorization'))) return refuse(403, 'Only the relay may call this.');
      const body = await readCapped(req, MAX_BODY);
      if (body === null) return refuse(413, 'Request too large.');

      try {
        const { site, model } = setup(env);
        // One executor per request: its gap reports run under this request's waitUntil, not another's.
        const executor = new SupportExecutor(site, () => model, contextStore(env), { keepAlive: (p) => ctx.waitUntil(p) });
        const handle = supportEndpoint({
          card: card(url.origin),
          executor,
          tasks: taskStore(env),
          fromRelay: () => true, // checked above, before the body
          beforeRead: (taskId) => taskObject(env, taskId).settleStale(),
        });
        return finishEvenIfDisconnected(await handle(new Request(req.url, { method: 'POST', headers: req.headers, body })), ctx);
      } catch (err) {
        console.error('[support] failed:', err instanceof Error ? err.message : err);
        return Response.json({ error: 'support failed.' }, { status: 500 });
      }
    },
  };
}
