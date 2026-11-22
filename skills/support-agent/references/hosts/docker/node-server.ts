/**
 * hosts/docker/node-server.ts — the Support Agent on node:http, no framework.
 * Shared by the docker profile (hosts/docker/server.ts) and the cloudrun profile
 * (hosts/cloudrun/server.ts), which differ only in where tasks, context and
 * turns live. No side effects: the entry files read the environment and listen.
 *
 * In the project this sits beside support-core.ts and the site adapter, so its
 * imports are './support-core' (and the entry files' './site').
 *
 *   POST /a2a/support                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/support/agent-card.json    its Agent Card, built from PUBLIC_ORIGIN
 *   GET  /.well-known/agent-card.json    the same card, unless `wellKnown` is false
 *   GET  /a2a/support/healthz            whether it can take a handoff now, under the
 *                                        path the front door already routes: for the
 *                                        relay's `availability`
 *   GET  /healthz                        the same, for the container's health check
 *                                        and Cloud Run's startup probe. Never routed
 *                                        publicly
 *
 * Both health paths answer `{ available }` only, unless the caller sends the
 * relay token: then the model, the store and the gap and turn settings too.
 *
 * Refusals, cheapest first: the method and path; the relay token, compared in
 * constant time before a byte of the body is read; the body, capped at 64 KB
 * while it streams (413), never buffered first.
 *
 * Gap reports go after the reply, and the response is held open until the
 * reports that turn started have settled (at most `reportWaitMs`). The reply's
 * events have all been written by then, so the visitor waits for nothing: only
 * the stream's end is later. That is what lets Cloud Run's request-scoped CPU
 * finish them, and what `server.close()` waits on at shutdown. `shutdown()`
 * then waits on `executor.settled()` for anything still in flight.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import {
  SupportExecutor,
  claudeSupportModel,
  gapReporting,
  helpReachable,
  supportAgentCard,
  supportEndpoint,
  type CardOptions,
  type ContextStore,
  type MessagesClient,
  type SupportModel,
  type SupportSite,
} from '../../support-core';

export const PATH = '/a2a/support';
export const CARD = `${PATH}/agent-card.json`;
export const WELL_KNOWN = '/.well-known/agent-card.json';
export const HEALTH = `${PATH}/healthz`;
/** The core's own cap is on the text; this one refuses while the body streams, before it is buffered. */
const MAX_BODY = 64_000;
/** Sonnet composes, Haiku rewrites. Override with SUPPORT_MODEL and SUPPORT_REWRITE_MODEL. */
export const DEFAULT_SUPPORT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_SUPPORT_REWRITE_MODEL = 'claude-haiku-5-5';

// ── Configuration ───────────────────────────────────────────────────────────

/** A secret from the environment, or from the file <NAME>_FILE names (a Docker or Secret Manager secret mounted as a file). */
export function secret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim() || undefined;
  return env[name]?.trim() || undefined;
}

/** A missing setting names itself at startup, not as a 403 on a visitor's turn. */
export function required(name: string, value: string | undefined): string {
  if (value) return value;
  console.error(`[support] ${name} is not set. See .env.example.`);
  process.exit(1);
}

/** The relay token: required, 32+ characters. No default: unset, nothing may call the agent. */
export function relayToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = required('A2A_RELAY_TOKEN', secret('A2A_RELAY_TOKEN', env));
  if (token.length < 32) {
    console.error('[support] A2A_RELAY_TOKEN is shorter than 32 characters. Make one with: openssl rand -hex 32');
    process.exit(1);
  }
  return token;
}

/**
 * The two models: Claude on ANTHROPIC_API_KEY, or through SUPPORT_MODEL_BASE_URL (a proxy that holds
 * its own key). Null when neither is set: the relay lists the agent unavailable.
 */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): { model: SupportModel | null; name: string | null } {
  const apiKey = secret('ANTHROPIC_API_KEY', env);
  const baseURL = env.SUPPORT_MODEL_BASE_URL || undefined;
  if (!apiKey && !baseURL) return { model: null, name: null };
  const compose = env.SUPPORT_MODEL || DEFAULT_SUPPORT_MODEL;
  const rewrite = env.SUPPORT_REWRITE_MODEL || DEFAULT_SUPPORT_REWRITE_MODEL;
  // Through a proxy, the SDK still wants a key: a placeholder never sent to Anthropic.
  const client = new Anthropic({ apiKey: apiKey || 'proxied', ...(baseURL ? { baseURL } : {}) });
  return { model: claudeSupportModel(client as unknown as MessagesClient, { compose, rewrite, modelHeader: !!baseURL }), name: `${compose} + ${rewrite}` };
}

// ── The server ──────────────────────────────────────────────────────────────

export interface NodeHostOptions {
  site: SupportSite;
  model: SupportModel | null;
  /** What /healthz names as the model, with the token. */
  modelName?: string | null;
  /** The SDK's tasks. */
  tasks: TaskStore;
  /** The core's context. */
  context: ContextStore;
  /** The store's name for /healthz, and a ping that throws when it can't be reached. */
  store: { name: string; ping(): Promise<void> };
  /** Runs before a GetTask or SubscribeToTask: fails a task a stopped instance left working. */
  beforeRead?: (taskId: string) => Promise<void>;
  /** The bearer token the relay sends. */
  relayToken: string;
  /** The site's origin, as the card points at it. Never the Host header. */
  publicOrigin: string;
  /** The card's words, without `origin` and `path`. */
  card: Omit<CardOptions, 'origin' | 'path'>;
  /** False when another agent on the site serves /.well-known/agent-card.json. Default true. */
  wellKnown?: boolean;
  /** How long a response is held open for the gap reports its turn started. Default 5 s. */
  reportWaitMs?: number;
  /** One line per request. Default console.info. */
  log?: (line: string) => void;
}

export interface NodeHost {
  server: Server;
  executor: SupportExecutor;
  /** Whether it can take a handoff now: a model, a reachable help corpus, a store that answers. */
  /** `gaps`: gap and close reports are sent (a sink, the secret and a store). `helpful`: 👍 counts are (a sink). */
  health(): Promise<{ available: boolean; model: string | null; store: string; corpus: boolean; gaps: boolean; helpful: boolean; turnRefs: boolean }>;
  /** Stop taking connections, let the requests in flight finish, wait for the reports still out, at most `graceMs` in all. */
  shutdown(graceMs: number): Promise<void>;
}

/** Request headers the endpoint reads. Nothing else is passed on, and nothing is logged. */
const PASSED = ['authorization', 'content-type', 'accept', 'a2a-version', 'a2a-extensions'];

/** Read the body, refusing as soon as it passes the cap rather than after buffering it. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.pause();
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** What the start-up line says about reports: which are sent, and why not when some aren't. */
export function reportsLine(site: SupportSite): string {
  const what = gapReporting(site);
  if (what === 'all') return 'gap reports: on (question keys and turn references; the wording and the turns stay in this host\'s store)';
  if (what === 'helpful') return 'gap reports: off (no SUPPORT_TURN_REF_SECRET, so no question key; question text is never sent); thumbs-up counts: on';
  return 'gap reports: off';
}

export function supportNodeHost(o: NodeHostOptions): NodeHost {
  const log = o.log ?? ((line: string) => console.info(line));
  const reportWaitMs = o.reportWaitMs ?? 5_000;
  const card = supportAgentCard({ ...o.card, origin: o.publicOrigin, path: PATH });

  // The reports each request's turn starts. The executor hands every report to `keepAlive`
  // inside the turn, which runs in the request's async context, so this finds its request.
  const scope = new AsyncLocalStorage<Set<Promise<unknown>>>();
  const executor = new SupportExecutor(o.site, () => o.model, o.context, {
    keepAlive: (p) => {
      const reports = scope.getStore();
      if (!reports) return;
      reports.add(p);
      void p.finally(() => reports.delete(p)).catch(() => {});
    },
  });

  const expected = createHash('sha256').update(`Bearer ${o.relayToken}`).digest();
  /** Compared in constant time: hashing first makes the lengths equal. */
  const fromRelay = (authorization: string | null | undefined) => !!authorization && timingSafeEqual(createHash('sha256').update(authorization).digest(), expected);

  const handle = supportEndpoint({ card, executor, tasks: o.tasks, fromRelay: (req) => fromRelay(req.headers.get('authorization')), beforeRead: o.beforeRead });
  const reachable = helpReachable(o.site.records);

  // A store ping may be a billed read (Firestore), and the relay asks on every page that loads the
  // harness: a good answer is kept for five seconds. A bad one is not.
  let storeOkAt = 0;
  async function health() {
    let storeOk = Date.now() - storeOkAt < 5_000;
    if (!storeOk) {
      storeOk = await o.store.ping().then(
        () => true,
        (err) => (console.warn(`[support] ${o.store.name} unreachable:`, err instanceof Error ? err.message : err), false),
      );
      if (storeOk) storeOkAt = Date.now();
    }
    const corpus = await reachable();
    return {
      available: o.model !== null && corpus && storeOk,
      model: o.modelName ?? (o.model ? 'configured' : null),
      store: storeOk ? o.store.name : `${o.store.name} unreachable`,
      corpus,
      gaps: gapReporting(o.site) === 'all',
      helpful: gapReporting(o.site) !== 'none',
      turnRefs: !!o.site.turns && !!o.site.turnRefSecret,
    };
  }

  /** Write the response out, streaming (server-sent events reach the relay one by one), then hold the end for this turn's reports. */
  async function send(res: ServerResponse, response: Response, reports: Set<Promise<unknown>>): Promise<void> {
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const body = Readable.fromWeb(response.body as never);
      body.pipe(res, { end: false });
      await new Promise<void>((resolve, reject) => body.on('end', resolve).on('error', reject));
    }
    // The executor starts its reports right after the turn's last event: let it, then wait for them.
    await new Promise<void>((r) => setImmediate(r));
    const deadline = Date.now() + reportWaitMs;
    while (reports.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...reports]), sleep(deadline - Date.now())]);
      await new Promise<void>((r) => setImmediate(r));
    }
    res.end();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://container').pathname;

    if (req.method === 'GET' && (path === '/healthz' || path === HEALTH)) {
      const h = await health();
      const status = h.store.endsWith('unreachable') ? 503 : 200;
      return json(res, status, fromRelay(req.headers.authorization) ? h : { available: h.available }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && (path === CARD || (o.wellKnown !== false && path === WELL_KNOWN))) return json(res, 200, card, { 'Cache-Control': 'public, max-age=300' });
    if (path !== PATH) return json(res, 404, { error: 'Not found.' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
    // The token before the body: a caller without it costs nothing to refuse.
    if (!fromRelay(req.headers.authorization)) return json(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Only the relay may call this.' } });

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      if ((err as { tooLarge?: boolean }).tooLarge) {
        res.on('finish', () => req.destroy());
        return json(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }, { Connection: 'close' });
      }
      throw err;
    }
    const headers = new Headers();
    for (const name of PASSED) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const reports = new Set<Promise<unknown>>();
    const response = await scope.run(reports, () => handle(new Request(`${o.publicOrigin}${PATH}`, { method: 'POST', headers, body })));
    await send(res, response, reports);
  }

  let stopping = false;
  const server = createServer((req, res) => {
    const started = Date.now();
    // Method, path, status and time only: no body, no headers, no address. The body is the
    // visitor's question, and the Authorization header is the relay token.
    res.on('finish', () => {
      log(`[support] ${req.method} ${(req.url ?? '/').split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`);
      // Shutting down: a keep-alive socket a finished request leaves idle would hold close() open.
      if (stopping) setImmediate(() => server.closeIdleConnections());
    });
    route(req, res).catch((err) => {
      console.error('[support] failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) json(res, 500, { error: 'support failed.' });
      else res.end();
    });
  });

  async function shutdown(graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    stopping = true;
    // Node 19+ closes idle keep-alive sockets here; requests in flight finish, each held for its reports.
    const closed = new Promise<void>((r) => server.close(() => r()));
    await Promise.race([closed, sleep(graceMs)]);
    // Anything a held response gave up on, or a report started without a request.
    await Promise.race([executor.settled(), sleep(Math.max(0, deadline - Date.now()))]);
  }

  return { server, executor, health, shutdown };
}

/**
 * SIGTERM and SIGINT: shut down within `graceMs`, run `close` (the store's client), exit. Node as
 * PID 1 does not handle SIGTERM by default; `docker stop` and Cloud Run both send it, then SIGKILL.
 */
export function exitOnSignal(host: NodeHost, graceMs: number, close: () => Promise<void> = async () => {}): void {
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.info(`[support] ${signal}: finishing the turns and gap reports in flight`);
      setTimeout(() => process.exit(0), graceMs + 500).unref();
      void host
        .shutdown(graceMs)
        .then(close)
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }
}
