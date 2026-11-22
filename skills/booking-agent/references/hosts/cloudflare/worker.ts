/**
 * hosts/cloudflare/worker.ts — the Booking Agent as a Cloudflare Worker, with
 * each task's state in a Durable Object.
 *
 * Put it at src/booking-worker.ts (or the Worker's main), with agent-core.ts and
 * the site adapter beside it, and wrangler.jsonc from this folder. See
 * hosts/cloudflare.md for when to choose this profile and how it is routed.
 *
 * Status: DRAFT. The quote agent's Cloudflare profile (verified locally under
 * `wrangler dev`) with this core and a claim per attempt; this booking version
 * type-checks against @cloudflare/workers-types but has not run under
 * `wrangler dev` or been deployed (see ../cloudflare.md). Say so to the user,
 * and run SKILL.md step 7 on a deployment before relying on it.
 *
 *   POST /a2a/booking                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/booking/agent-card.json    its Agent Card, built from the request's origin
 *   GET  /.well-known/agent-card.json  the same card — unless BOOKING_CARD_WELL_KNOWN is "false"
 *
 * Host answers:
 * - Server code: this Worker, on a route of the site's own zone
 *   (example.com/a2a/booking*), or as the site itself (Workers static assets).
 *   `wrangler dev` serves it on http://localhost:8787.
 * - Where tasks live: one Durable Object per task (BookingTask below) holds the
 *   SDK's task, agent-core's progress and a submit marker per attempt. Requests for one
 *   task may land on any Worker instance anywhere; they all reach the same
 *   object, which runs one call at a time with strongly consistent storage.
 *   NOT Workers KV: it is eventually consistent (a "yes" may read a stale
 *   summary) and has no conditional write, so it cannot hold the claim.
 * - Conditional write: `claim` reads and writes the marker synchronously in
 *   the object (the SQLite-backed `ctx.storage.kv` API) — no await between the
 *   check and the set, so no other call on that object can run in between.
 * - Secrets: Worker secrets (`wrangler secret put ANTHROPIC_API_KEY`,
 *   `A2A_RELAY_TOKEN`, `NXIS_WEBHOOK_SIGNING_SECRET`, and
 *   `BOOKING_AVAILABILITY_TOKEN` if the calendar wants one); BOOKING_MODEL,
 *   BOOKING_SINK_URL and BOOKING_AVAILABILITY_URL are plain vars. Locally,
 *   .dev.vars (never committed).
 * - Response time: no wall-clock limit while the relay stays connected; CPU
 *   time is what is metered, and a turn is mostly waiting (model, sink,
 *   Durable Object). If the relay disconnects mid-turn, `ctx.waitUntil` keeps
 *   the turn running (up to 30 s) so a claimed submission is still sent and
 *   recorded. A task left working longer than a turn can take is failed on
 *   its next read.
 *
 * Needs `compatibility_flags: ["nodejs_compat"]`: @a2a-js/sdk uses `Buffer`
 * for raw parts, and example-site.ts signs with node:crypto's createHmac.
 */
import { DurableObject } from 'cloudflare:workers';
import Anthropic from '@anthropic-ai/sdk';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import {
  BookingExecutor,
  claudeModel,
  bookingAgentCard,
  bookingEndpoint,
  type MessagesClient,
  type Progress,
  type ProgressStore,
  type BookingModel,
  type BookingSite,
} from '../../agent-core';
import { RULES, exampleSite, httpAvailability, webhookSink } from '../../example-site';

const PATH = '/a2a/booking';
const CARD = `${PATH}/agent-card.json`;
const WELL_KNOWN = '/.well-known/agent-card.json';
/** A current Sonnet. Override with BOOKING_MODEL. Not exported: workerd takes every named export of the main module as an entrypoint, and refuses one that is not a handler. */
const DEFAULT_BOOKING_MODEL = 'claude-sonnet-5-5';
/** The same cap as agent-core, enforced here while the body streams in. */
const MAX_BODY = 64_000;
/** Longer than any single turn takes; a task working for longer was cut off. */
const STALE_WORKING_MS = 90_000;
/** How long a finished or abandoned task's object keeps its storage. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface Env {
  /** The Durable Object namespace, bound in wrangler.jsonc. */
  BOOKING_TASKS: DurableObjectNamespace<BookingTask>;
  /** Secret. Unset: the agent is offered as unavailable, and the form takes bookings. */
  ANTHROPIC_API_KEY?: string;
  /** Secret, shared with the relay (its target's credential). No default: unset, nothing may call the agent. */
  A2A_RELAY_TOKEN?: string;
  /** Var. Defaults to DEFAULT_BOOKING_MODEL. */
  BOOKING_MODEL?: string;
  /** Secret. Signs the agent's posts to the sink, as the sink verifies them. */
  NXIS_WEBHOOK_SIGNING_SECRET?: string;
  /** Var. Where the form's submissions go, fixed server-side. Never taken from a request. */
  BOOKING_SINK_URL?: string;
  /** Var. The site's free-slot endpoint, fixed server-side. Unset: offered as unavailable. */
  BOOKING_AVAILABILITY_URL?: string;
  /** Secret. The availability endpoint's bearer, if it wants one. */
  BOOKING_AVAILABILITY_TOKEN?: string;
  /** Var. "false" when another agent already serves /.well-known/agent-card.json. */
  BOOKING_CARD_WELL_KNOWN?: string;
  /** Present when this Worker also serves the site's files (Workers static assets). */
  ASSETS?: Fetcher;
}

// ── One Durable Object per task ─────────────────────────────────────────────

/**
 * A task's state: the SDK's task JSON, agent-core's progress, and the submit
 * marker. A Durable Object runs one call at a time and its storage is strongly
 * consistent, so every Worker instance sees the same summary awaiting a yes,
 * and only one claim ever wins.
 */
export class BookingTask extends DurableObject<Env> {
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

  getProgress(): Progress | null {
    return this.kv.get<Progress>('progress') ?? null;
  }
  setProgress(p: Progress): void {
    this.kv.put('progress', p);
    this.touch();
  }
  /** Progress only. The `sent` marker outlives it, so a late duplicate still finds the task claimed. */
  deleteProgress(): void {
    this.kv.delete('progress');
  }

  /**
   * The single-submit guarantee, per attempt. Synchronous: nothing else runs on
   * this object between the check and the write, so of any number of
   * concurrent claims — from any instance — exactly one gets true.
   */
  claim(attempt: string): boolean {
    if (this.kv.get(`sent:${attempt}`)) return false;
    this.kv.put(`sent:${attempt}`, { at: Date.now() });
    this.touch();
    return true;
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
        message: { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: "Sorry — that took too long. The site's booking form still works." }] },
      },
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const taskObject = (env: Env, taskId: string) => env.BOOKING_TASKS.get(env.BOOKING_TASKS.idFromName(taskId));

/** The SDK's tasks, in its own JSON, each in its task's object. */
const taskStore = (env: Env): TaskStore => ({
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

const progressStore = (env: Env): ProgressStore => ({
  get: async (id) => ((await taskObject(env, id).getProgress()) as Progress | null) ?? null,
  set: async (id, p) => void (await taskObject(env, id).setProgress(p)),
  delete: async (id) => void (await taskObject(env, id).deleteProgress()),
  // The key is `<taskId>.<attempt>` (agent-core's idempotencyKey): the task's object holds every attempt's marker.
  claim: (key) => {
    const at = key.lastIndexOf('.');
    return taskObject(env, key.slice(0, at)).claim(key.slice(at + 1));
  },
});

// ── Relay only ──────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Constant-time comparison of the bearer token with the secret. No secret: nothing gets in. */
function fromRelay(env: Env, req: Request): boolean {
  const token = env.A2A_RELAY_TOKEN;
  if (!token) return false;
  const given = encoder.encode(req.headers.get('authorization') ?? '');
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

const refuse = (status: number, message: string) => Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }, { status });

/**
 * Turns still running in this isolate. A turn can outlive its own response: two
 * messages to one task at once (a double "yes") make the SDK end one stream
 * with an error while its turn — the claim, then the sink — is still running,
 * and the runtime cancels whatever a finished request left pending. Every
 * response waits for these under `waitUntil`, so a claimed booking is always
 * sent and recorded.
 */
const inflight = new Set<Promise<void>>();

class TrackedExecutor extends BookingExecutor {
  override execute(...args: Parameters<BookingExecutor['execute']>): Promise<void> {
    const turn = super.execute(...args);
    inflight.add(turn);
    void turn.finally(() => inflight.delete(turn));
    return turn;
  }
}

/** Keep the request alive until the turns in flight have finished. */
const settleTurns = async () => {
  while (inflight.size) await Promise.allSettled([...inflight]);
};

/**
 * Stream the endpoint's events to the relay, and keep reading them to the end
 * even if the relay goes away: the turn behind them (a claim, then the sink)
 * finishes under `waitUntil` instead of being cut off between the two.
 */
function finishEvenIfDisconnected(res: Response, ctx: ExecutionContext): Response {
  ctx.waitUntil(new Promise((r) => setTimeout(r, 0)).then(settleTurns));
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
      await settleTurns();
    })(),
  );
  return new Response(readable, { status: res.status, headers: res.headers });
}

// ── The agent ───────────────────────────────────────────────────────────────

/** Whether it can take a handoff now: only with a model key. The relay target's `availability`. */
export const bookingAvailability = async (env: Env) => ({ available: Boolean(env.ANTHROPIC_API_KEY && env.BOOKING_AVAILABILITY_URL) });

/** EXAMPLE: the card's words. The name matches BookingSite.agentName and the relay's label. */
const card = (origin: string) =>
  bookingAgentCard({
    origin,
    path: PATH,
    name: 'Northside Booking',
    description:
      'Books a plumbing or heating visit in conversation — asks one question at a time, offers only the free times on the calendar, confirms the details with the visitor, books it with Northside Plumbing, and returns a booking reference.',
    organization: 'Northside Plumbing',
    collects:
      "Collects the service, a day and one of the free arrival windows (in the business's time zone), and the visitor's name, phone, address and optional email; confirms them with the visitor; books it as the site's booking form would; and returns a booking reference.",
    examples: ['Can someone look at my water heater tomorrow?', 'Book a drain cleaning for next week'],
    tags: ['booking', 'appointment', 'schedule', 'home services'],
  });

const claude = (env: Env): BookingModel | null =>
  env.ANTHROPIC_API_KEY && env.BOOKING_AVAILABILITY_URL
    ? claudeModel(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) as unknown as MessagesClient, env.BOOKING_MODEL || DEFAULT_BOOKING_MODEL)
    : null;

// EXAMPLE sink: the endpoint the site's form posts to, fixed server-side. For a form whose
// handler saves to the site's own database, use appSink with the handler's save function.
const webhookSite = (env: Env): BookingSite =>
  exampleSite({
    // EXAMPLE source: the site's free-slot endpoint, fixed server-side.
    availability: httpAvailability({
      url: () => {
        if (!env.BOOKING_AVAILABILITY_URL) throw new Error('BOOKING_AVAILABILITY_URL is not set');
        return env.BOOKING_AVAILABILITY_URL;
      },
      headers: (): Record<string, string> => (env.BOOKING_AVAILABILITY_TOKEN ? { Authorization: `Bearer ${env.BOOKING_AVAILABILITY_TOKEN}` } : {}),
    }),
    sink: webhookSink({
      url: () => {
        if (!env.BOOKING_SINK_URL) throw new Error('BOOKING_SINK_URL is not set');
        return env.BOOKING_SINK_URL;
      },
      secret: env.NXIS_WEBHOOK_SIGNING_SECRET || undefined,
      timeZone: RULES.timeZone,
    }),
  });

export interface BookingWorkerOptions {
  /** The model per request; null when none is configured. Defaults to Claude on ANTHROPIC_API_KEY. */
  model?: (env: Env) => BookingModel | null;
  /** The site adapter. Defaults to the example site posting to BOOKING_SINK_URL. */
  site?: (env: Env) => BookingSite;
}

/** The Worker. `export default bookingWorker()`; tests pass a scripted model. */
export function bookingWorker(opts: BookingWorkerOptions = {}): ExportedHandler<Env> {
  const model = opts.model ?? claude;
  const site = opts.site ?? webhookSite;
  // One endpoint per origin the Worker is reached on (custom domain, workers.dev), so the card each serves points at itself.
  const handlers = new Map<string, (req: Request) => Promise<Response>>();
  const endpoint = (env: Env, origin: string) => {
    let handle = handlers.get(origin);
    if (!handle) {
      const tasks = taskStore(env);
      const bookingModel = model(env);
      handle = bookingEndpoint({
        card: card(origin),
        executor: new TrackedExecutor(site(env), () => bookingModel, progressStore(env)),
        tasks,
        fromRelay: (req) => fromRelay(env, req),
        beforeRead: (taskId) => taskObject(env, taskId).settleStale(),
      });
      handlers.set(origin, handle);
    }
    return handle;
  };

  return {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      const wellKnown = env.BOOKING_CARD_WELL_KNOWN !== 'false';

      if (url.pathname === CARD || (wellKnown && url.pathname === WELL_KNOWN)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
        return Response.json(card(url.origin));
      }
      if (url.pathname !== PATH) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });

      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      // Token before body: an unauthenticated caller never gets as far as reading one.
      if (!fromRelay(env, req)) return refuse(403, 'Only the relay may call this.');
      const body = await readCapped(req, MAX_BODY);
      if (body === null) return refuse(413, 'Request too large.');

      try {
        const res = await endpoint(env, url.origin)(new Request(req.url, { method: 'POST', headers: req.headers, body }));
        return finishEvenIfDisconnected(res, ctx);
      } catch (err) {
        console.error('[booking] failed:', err);
        return Response.json({ error: 'booking failed.' }, { status: 500 });
      }
    },
  };
}

export default bookingWorker();
