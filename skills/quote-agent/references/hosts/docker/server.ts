/**
 * hosts/docker/server.ts — the Quote Agent as a container of its own:
 * node:http in front of agent-core.ts, no framework.
 *
 * Status: see hosts/docker.md. In the project this sits beside agent-core.ts
 * and the site adapter, so its imports are './agent-core' and './site'.
 *
 *   POST /a2a/quote                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/quote/agent-card.json    its Agent Card
 *   GET  /.well-known/agent-card.json  the same card (the reverse proxy routes it
 *                                      only if no other agent on the site claims it)
 *   GET  /healthz                      whether it can take a handoff now: for the
 *                                      container's healthcheck and the relay's
 *                                      `availability`. Never routed publicly
 *
 * The relay reaches the endpoint over the internal network (loopback, or the
 * compose network), with the relay token. The page never calls it; the site's
 * reverse proxy routes the card paths here, and `/a2a/quote` so the card's URL
 * answers (403 without the token).
 *
 * Refusals, cheapest first: the method and path; the relay token, before a
 * byte of the body is read; the body, capped while it streams.
 *
 * Environment (read once, at startup — see .env.example):
 *   A2A_RELAY_TOKEN     required: the bearer token the relay sends. No default
 *   PUBLIC_ORIGIN       required: the site's origin, as the card points at it
 *   QUOTE_SINK_URL      required: where the form's submissions go, fixed here
 *   ANTHROPIC_API_KEY   unset: no model, `available: false`, the form takes quotes
 *   QUOTE_MODEL         default a current Sonnet
 *   NXIS_WEBHOOK_SIGNING_SECRET   signs the posts to the sink
 *   REDIS_URL           set: tasks, progress and the claim in Redis (any number of
 *                       replicas). Unset: memory, and exactly one replica
 * Each secret may instead come from a file named by <NAME>_FILE (a Docker secret).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import { QuoteExecutor, claudeModel, memoryProgress, quoteAgentCard, quoteEndpoint, type MessagesClient, type QuoteModel } from '../../agent-core';
import { exampleSite, webhookSink } from '../../example-site';
import { connectRedis, redisStores, type Redis } from './redis-store';

const PORT = Number(process.env.PORT ?? 4120);
const PATH = '/a2a/quote';
const CARD = `${PATH}/agent-card.json`;
const WELL_KNOWN = '/.well-known/agent-card.json';
/** The core's own cap is on the text; this one refuses while the body streams, before it is buffered. */
const MAX_BODY = 64_000;
/** A current Sonnet. Override with QUOTE_MODEL. */
const MODEL = process.env.QUOTE_MODEL || 'claude-sonnet-5-5';

// ── Configuration, once ─────────────────────────────────────────────────────

/** A secret from the environment, or from the file <NAME>_FILE names (/run/secrets/…). */
function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim() || undefined;
  return process.env[name] || undefined;
}

/** A missing setting names itself here, not as a 403 or a failed send on a visitor's turn. */
function required(name: string, value: string | undefined): string {
  if (value) return value;
  console.error(`[quote] ${name} is not set. See .env.example.`);
  process.exit(1);
}

const RELAY_TOKEN = required('A2A_RELAY_TOKEN', secret('A2A_RELAY_TOKEN'));
if (RELAY_TOKEN.length < 32) {
  console.error('[quote] A2A_RELAY_TOKEN is shorter than 32 characters. Make one with: openssl rand -hex 32');
  process.exit(1);
}
const PUBLIC_ORIGIN = new URL(required('PUBLIC_ORIGIN', process.env.PUBLIC_ORIGIN)).origin;
const SINK_URL = required('QUOTE_SINK_URL', process.env.QUOTE_SINK_URL);
const API_KEY = secret('ANTHROPIC_API_KEY');

/**
 * TEST ONLY: QUOTE_TEST_MODEL=scripted, honored only with no API key. It asks
 * for the values, and takes a message that is a JSON object of them as ready —
 * so step 7's checks run without a key or a bill. Every rule around the model
 * (the summary, the yes, the claim, the sink) runs as in production.
 */
const scriptedModel: QuoteModel = {
  async decide({ messages }) {
    try {
      const values = JSON.parse(messages[messages.length - 1]?.content ?? '');
      if (values && typeof values === 'object' && !Array.isArray(values)) return { action: 'ready', values };
    } catch {
      // Not JSON: ask.
    }
    return { action: 'ask', question: 'What are the details? (Test model: reply with the values as one JSON object.)' };
  },
};

const model: QuoteModel | null = API_KEY
  ? claudeModel(new Anthropic({ apiKey: API_KEY }) as unknown as MessagesClient, MODEL)
  : process.env.QUOTE_TEST_MODEL === 'scripted'
    ? scriptedModel
    : null;
const modelName = API_KEY ? MODEL : model ? 'scripted (TEST ONLY)' : null;

// ── Where tasks live ────────────────────────────────────────────────────────

// REDIS_URL set means Redis is required: starting on memory instead would let
// two replicas each submit. Unreachable at startup, exit, and let compose restart.
let redis: Redis | null = null;
if (process.env.REDIS_URL) {
  try {
    redis = await connectRedis(process.env.REDIS_URL);
  } catch (err) {
    console.error('[quote] REDIS_URL is set but Redis is unreachable:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
const stores = redis ? redisStores(redis) : null;

// ── The agent ───────────────────────────────────────────────────────────────

/** EXAMPLE: the card's words. The name matches QuoteSite.agentName and the relay's label. */
const card = () =>
  quoteAgentCard({
    origin: PUBLIC_ORIGIN,
    path: PATH,
    name: 'Ridgeline Quotes',
    description:
      'Takes a roofing quote or estimate request in conversation — asks one question at a time, confirms the details with the visitor, sends it to Ridgeline Roofing, and returns a quote reference.',
    organization: 'Ridgeline Roofing',
    collects:
      "Collects the visitor's name, email, optional phone, the service, the timeline and a description of the job, confirms them with the visitor, sends them as the site's quote form would, and returns a quote reference.",
    examples: ['Can I get a quote for a new roof?', 'How much would it cost to replace my gutters?'],
    tags: ['quote', 'estimate', 'roofing', 'home services'],
  });

// EXAMPLE sink: the endpoint the site's form posts to, fixed here. For a form whose handler
// saves to the site's own database, use appSink with the handler's save function.
const site = exampleSite({ sink: webhookSink({ url: () => SINK_URL, secret: secret('NXIS_WEBHOOK_SIGNING_SECRET') }) });

/** The relay's credential, compared in constant time: hashing first makes the lengths equal. */
const expected = createHash('sha256').update(`Bearer ${RELAY_TOKEN}`).digest();
const fromRelay = (authorization: string | null | undefined) =>
  !!authorization && timingSafeEqual(createHash('sha256').update(authorization).digest(), expected);

const handle = quoteEndpoint({
  card: card(),
  executor: new QuoteExecutor(site, () => model, stores?.progress ?? memoryProgress()),
  tasks: stores?.tasks ?? new InMemoryTaskStore(),
  fromRelay: (req) => fromRelay(req.headers.get('authorization')),
  beforeRead: stores?.failStale,
});

/** Whether it can take a handoff now: a model, and a store that answers. */
async function health() {
  let store = 'memory';
  if (redis) store = await redis.ping().then(() => 'redis', () => 'redis unreachable');
  return { available: model !== null && store !== 'redis unreachable', model: modelName, store };
}

// ── node:http ───────────────────────────────────────────────────────────────

/** Read the body, refusing as soon as it passes the cap rather than after buffering it. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop reading; the caller answers 413 and then closes the socket.
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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
};

/** Write a `Response` out, streaming: server-sent events must reach the relay one by one. */
function send(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as never).pipe(res);
}

/** Request headers the endpoint reads. Nothing else is passed on — and nothing is logged. */
const PASSED = ['authorization', 'content-type', 'accept', 'a2a-version', 'a2a-extensions'];

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://container').pathname;

  if (req.method === 'GET' && path === '/healthz') {
    const h = await health();
    return json(res, h.store === 'redis unreachable' ? 503 : 200, h);
  }
  // Built per request from the configured origin: behind a reverse proxy, the Host header is the container's.
  if (req.method === 'GET' && (path === CARD || path === WELL_KNOWN)) return json(res, 200, card(), { 'Cache-Control': 'public, max-age=300' });
  if (path !== PATH) return json(res, 404, { error: 'Not found.' });
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  // The token before the body: a caller without it costs nothing to refuse.
  if (!fromRelay(req.headers.authorization)) {
    return json(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Only the relay may call this.' } });
  }

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
  send(res, await handle(new Request(`${PUBLIC_ORIGIN}${PATH}`, { method: 'POST', headers, body })));
}

const server = createServer((req, res) => {
  const started = Date.now();
  // Method, path, status and time only: no body, no headers, no address. The
  // conversation is the visitor's name, email, phone and job.
  res.on('finish', () => console.info(`[quote] ${req.method} ${(req.url ?? '/').split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`));
  route(req, res).catch((err) => {
    console.error('[quote] failed:', err instanceof Error ? err.message : err);
    if (!res.headersSent) json(res, 500, { error: 'quote failed.' });
    else res.end();
  });
});

// 0.0.0.0 inside the container is fine: compose publishes the port on loopback only.
server.listen(PORT, '0.0.0.0', () => {
  console.info(
    `[quote] Quote Agent on :${PORT}, card for ${PUBLIC_ORIGIN} — model: ${modelName ?? 'none (no ANTHROPIC_API_KEY), so offered as unavailable'}; store: ${redis ? 'redis' : 'memory (one replica only)'}`,
  );
  if (modelName?.startsWith('scripted')) console.warn('[quote] QUOTE_TEST_MODEL=scripted: a test model, not for a live site.');
});

// docker stop sends SIGTERM to PID 1, which Node does not handle by default: finish the turns in flight, then go.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await redis?.quit().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
