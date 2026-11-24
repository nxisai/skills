/**
 * hosts/receiver.ts — the part of an action receiver that is the same on every
 * host: verify NxisAI's signature over the raw body, tell a check from a
 * commit, and commit at most once per Idempotency-Key. Each host file
 * (nextjs.ts, netlify.ts, vercel.ts, cloudflare.ts, node.ts) only reads the
 * raw body and hands it here; submissions.ts is where the submission goes,
 * and bookings.ts answers a booking's availability and holds.
 *
 * Copy this file, submissions.ts, bookings.ts and the one host file the
 * project needs.
 *
 * What a check answers (`"nxis:mode": "check"`, also sent as
 * `X-Nxis-Mode: check`), always 200, and never a commit:
 *
 *   Booking  { "available": bool,
 *              "windows": [{ "start", "end", "open" }],   seats left per window
 *              "hold": { "token", "expires_at" },         for one window, when it has a seat
 *              "alternatives": [...], "reason": "…" }     when it isn't available
 *   Quote    { "available": bool, "service_area": bool, "fields": [...],
 *              "alternatives": [], "reason": "…" }         each optional but `available`
 *
 * A booking commit may carry `hold_token` from a check: it is honored until
 * `expires_at`. See bookings.ts for the rules.
 *
 * The signature, as NxisAI sends it on every call (the site's MCP server and
 * the hosted agents alike):
 *
 *   X-Nxis-Signature: t=<unix seconds>,v1=<lowercase hex>
 *   v1 = HMAC-SHA256(key = the connection's secret as UTF-8,
 *                    message = "<t>." followed by the exact body bytes)
 *
 * Web Crypto only (no node:crypto), so the same file runs on Node 18+, on
 * Netlify, Vercel and Next.js, and on Cloudflare Workers without
 * nodejs_compat. `crypto.subtle.verify` compares in constant time.
 */

import type { BookingCalendar } from './bookings';

export const SIGNATURE_HEADER = 'x-nxis-signature';
export const MODE_HEADER = 'x-nxis-mode';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Refuse a signature older or newer than this: a captured call can't be replayed later. */
export const TOLERANCE_SECONDS = 300;
/** Submissions are small. A larger body is refused before it is verified. */
export const MAX_BODY_BYTES = 64 * 1024;

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const PENDING_TTL_SECONDS = 60;

const encoder = new TextEncoder();

// ── Signature ────────────────────────────────────────────────────────────────

// No declared return types on these two: the inferred ones are what crypto.subtle accepts.
function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function signedMessage(timestamp: number, body: Uint8Array) {
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  return message;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

const asBytes = (body: Uint8Array | string): Uint8Array => (typeof body === 'string' ? encoder.encode(body) : body);

/** The header value NxisAI would send. For tests and local trials only; the receiver never signs. */
export async function signatureHeader(secret: string, timestamp: number, body: Uint8Array | string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), signedMessage(timestamp, asBytes(body)));
  return `t=${timestamp},v1=${bytesToHex(mac)}`;
}

export type Verification = { ok: true; signature: string } | { ok: false; reason: string };

/**
 * Checks the header against each secret: the current one and, during a
 * rotation, the one before it. Several `v1=` values are accepted, as are
 * unknown fields, so a later signature version doesn't break this receiver.
 */
export async function verifySignature(
  header: string | null,
  body: Uint8Array | string,
  secrets: string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Verification> {
  if (secrets.length === 0) return { ok: false, reason: 'The receiver has no signing secret configured.' };
  if (!header) return { ok: false, reason: 'Missing X-Nxis-Signature header.' };

  let t: number | null = null;
  const given: string[] = [];
  for (const part of header.split(',')) {
    const [k, ...rest] = part.trim().split('=');
    const v = rest.join('=').trim();
    if (k === 't' && /^\d+$/.test(v)) t = Number(v);
    if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) given.push(v.toLowerCase());
  }
  if (t === null || given.length === 0) return { ok: false, reason: 'Malformed X-Nxis-Signature header.' };
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return { ok: false, reason: 'Signature timestamp is outside the allowed window.' };

  const message = signedMessage(t, asBytes(body));
  for (const secret of secrets) {
    const key = await hmacKey(secret, 'verify');
    for (const v1 of given) {
      if (await crypto.subtle.verify('HMAC', key, hexToBytes(v1), message)) return { ok: true, signature: v1 };
    }
  }
  return { ok: false, reason: 'Signature does not match.' };
}

/** NXIS_ACTION_SECRET, plus NXIS_ACTION_SECRET_PREVIOUS while a rotation settles. */
export function secretsFrom(env: Record<string, string | undefined>): string[] {
  return [env.NXIS_ACTION_SECRET, env.NXIS_ACTION_SECRET_PREVIOUS]
    .flatMap((v) => (v ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Idempotency ──────────────────────────────────────────────────────────────

/**
 * Where commits are remembered, so a retried call gets the first answer back
 * instead of a second booking. `claim` must be atomic (set only if absent).
 *
 * memoryStore() is right for one long-running process (an Express or Fastify
 * server with one instance). On serverless hosts each request can land on a
 * fresh instance with an empty memory, so give those a shared store: a
 * database table with a unique key, Redis `SET NX`, Netlify Blobs with
 * `onlyIfNew`, a Cloudflare Durable Object. Until then, deliver() gets the key
 * too, so the place a submission lands can refuse a duplicate itself.
 */
export interface IdempotencyStore {
  get(key: string): Promise<StoredAnswer | null>;
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  put(key: string, value: StoredAnswer, ttlSeconds: number): Promise<void>;
  release(key: string): Promise<void>;
}

export type StoredAnswer = { state: 'pending' } | { state: 'done'; hash: string; answer: Answer };

export function memoryStore(): IdempotencyStore {
  const items = new Map<string, { value: StoredAnswer; expires: number }>();
  const live = (key: string) => {
    const item = items.get(key);
    if (item && item.expires <= Date.now()) items.delete(key);
    return items.get(key) ?? null;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async claim(key, ttl) {
      if (live(key)) return false;
      items.set(key, { value: { state: 'pending' }, expires: Date.now() + ttl * 1000 });
      return true;
    },
    async put(key, value, ttl) {
      items.set(key, { value, expires: Date.now() + ttl * 1000 });
    },
    async release(key) {
      items.delete(key);
    },
  };
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new Uint8Array(asBytes(bytes))));
}

// ── The receiver ─────────────────────────────────────────────────────────────

export type Answer = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

/** What arrived, verified and parsed. */
export interface Submission {
  /** For a booking commit: the window bookings.ts took a seat in, and whether a hold had kept it. */
  booking?: { start: string; end: string; held: boolean };
  /** The JSON object NxisAI sent: the action's arguments. */
  args: Record<string, unknown>;
  /** `?action=` on the connection's address, when the address names one. */
  action: string | null;
  /** The Idempotency-Key header, or one derived from the signature. Pass it on so the destination can refuse a duplicate. */
  idempotencyKey: string;
}

/** What committing a submission came to. */
export type Delivery =
  | { reference: string; extra?: Record<string, unknown> }
  | { conflict: string; code?: string; alternatives?: unknown[] }
  | { rejected: string; errors?: Record<string, string> };

/** What a check came to: never a commit (a booking's hold only keeps a seat until it expires). */
export interface Availability {
  available: boolean;
  /** Booking: the windows asked about, or the next open ones, each with `open` seats. */
  windows?: { start: string; end: string; open?: number }[];
  /** Booking: a seat kept for one window until `expires_at`, for the commit to send back as `hold_token`. */
  hold?: { token: string; expires_at: string };
  alternatives?: unknown[];
  reason?: string;
  /** Quote: whether the address given is one the business serves. */
  service_area?: boolean;
  /** Quote: the fields the request still needs, or that the business asks for. */
  fields?: unknown[];
  /** Arguments that couldn't be read, by name. */
  errors?: Record<string, string>;
}

export interface ReceiverOptions {
  secrets: string[];
  store: IdempotencyStore;
  /** Commit: store or forward the submission. Called at most once per idempotency key. */
  deliver: (submission: Submission) => Promise<Delivery>;
  /** Check: answer whether it would succeed, and commit nothing. Runs first for a booking too, and can refuse it. */
  check: (submission: Submission) => Promise<Availability>;
  /** Bookings: windows, seats and holds (bookings.ts). Without it, a booking is checked and committed like anything else. */
  bookings?: BookingCalendar;
  /** For tests. */
  nowSeconds?: () => number;
}

/** The host-neutral request: the method, the exact body bytes, a header getter and the URL. */
export interface RawRequest {
  method: string;
  url: string;
  body: Uint8Array | string | null;
  header(name: string): string | null;
}

const reply = (status: number, body: Record<string, unknown>, headers?: Record<string, string>): Answer => ({ status, body, headers });

/** One call from NxisAI, verified before anything is parsed. */
export async function receive(req: RawRequest, opts: ReceiverOptions): Promise<Answer> {
  if (req.method !== 'POST') return reply(405, { status: 'rejected', message: 'Use POST.' }, { Allow: 'POST' });
  if (req.body === null) return reply(413, { status: 'rejected', message: 'Body too large.' });
  const raw = asBytes(req.body);
  if (raw.length > MAX_BODY_BYTES) return reply(413, { status: 'rejected', message: 'Body too large.' });

  const verified = await verifySignature(
    req.header(SIGNATURE_HEADER),
    raw,
    opts.secrets,
    opts.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
  );
  if (!verified.ok) return reply(401, { status: 'rejected', message: verified.reason });

  // Verified. Only now parse.
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    args = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { status: 'rejected', message: "The body must be a JSON object of the action's arguments." });
  }

  // `"nxis:mode": "check"` is in the signed body; the header says the same. Either
  // one makes this a check, which only ever answers and never commits.
  const check = args['nxis:mode'] === 'check' || (req.header(MODE_HEADER) ?? '').toLowerCase() === 'check';
  let action: string | null = null;
  try {
    action = new URL(req.url, 'http://localhost').searchParams.get('action');
  } catch {
    // A host that gives no usable URL: no action hint.
  }
  const idempotencyKey = req.header(IDEMPOTENCY_HEADER)?.trim() || `sig:${verified.signature}`;
  const submission: Submission = { args, action, idempotencyKey };

  const calendar = opts.bookings?.handles(submission) ? opts.bookings : null;

  try {
    if (check) {
      const base = await opts.check(submission);
      // The project's own check can refuse first (outside the service area, say); then the calendar answers.
      return reply(200, checkBody(calendar && base.available ? await calendar.check(submission) : base));
    }
    return await once(opts.store, idempotencyKey, raw, async () =>
      answerFor(calendar ? await calendar.commit(submission, opts.deliver) : await opts.deliver(submission)),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'NotConfigured') return reply(501, { status: 'error', message: err.message });
    // Never log the body or the secret: a submission carries someone's details.
    console.error('[nxis-action] failed:', err instanceof Error ? err.message : 'unknown error');
    return reply(500, { status: 'error', message: 'The request could not be completed. Retry shortly.' });
  }
}

function checkBody(a: Availability): Record<string, unknown> {
  return {
    available: a.available,
    ...(a.windows ? { windows: a.windows } : {}),
    ...(a.hold ? { hold: a.hold } : {}),
    alternatives: a.alternatives ?? [],
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.service_area !== undefined ? { service_area: a.service_area } : {}),
    ...(a.fields ? { fields: a.fields } : {}),
    ...(a.errors ? { errors: a.errors } : {}),
  };
}

function answerFor(d: Delivery): Answer {
  if ('reference' in d) return reply(200, { status: 'confirmed', confirmation_id: d.reference, reference: d.reference, ...d.extra });
  if ('conflict' in d) {
    return reply(409, { status: 'conflict', reason: d.conflict, ...(d.code ? { code: d.code } : {}), alternatives: d.alternatives ?? [] });
  }
  return reply(422, { status: 'rejected', message: d.rejected, errors: d.errors ?? {} });
}

/**
 * Runs `commit` at most once per key. A confirmed answer is kept for a day and
 * returned again for a repeat; a conflict or a rejection is not kept, so a
 * corrected call with the same key goes through. The same key with a
 * different body is refused.
 */
async function once(store: IdempotencyStore, key: string, raw: Uint8Array, commit: () => Promise<Answer>): Promise<Answer> {
  const storeKey = `nxis-idem:${await sha256(key)}`;
  const hash = await sha256(raw);
  for (let attempt = 0; attempt < 25; attempt++) {
    const existing = await store.get(storeKey);
    if (existing?.state === 'done') {
      if (existing.hash !== hash) {
        return reply(422, { status: 'rejected', message: 'Idempotency-Key reused with a different request.' });
      }
      return { ...existing.answer, headers: { ...existing.answer.headers, 'Idempotent-Replayed': 'true' } };
    }
    if (!existing && (await store.claim(storeKey, PENDING_TTL_SECONDS))) {
      let answer: Answer;
      try {
        answer = await commit();
      } catch (err) {
        await store.release(storeKey).catch(() => {});
        throw err;
      }
      if (answer.status >= 200 && answer.status < 300) await store.put(storeKey, { state: 'done', hash, answer }, IDEMPOTENCY_TTL_SECONDS);
      else await store.release(storeKey);
      return answer;
    }
    // The same call is in flight elsewhere: wait for its answer.
    await new Promise((r) => setTimeout(r, 200));
  }
  return reply(503, { status: 'pending', message: 'The same request is still being processed. Retry shortly.' });
}

// ── Web-standard Request and Response (Next.js, Netlify, Vercel, Workers) ────

/** Reads at most MAX_BODY_BYTES as they stream; null when the body is larger. */
export async function readCapped(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function handleRequest(req: Request, opts: ReceiverOptions): Promise<Response> {
  const body = req.method === 'POST' ? await readCapped(req) : new Uint8Array();
  const answer = await receive({ method: req.method, url: req.url, body, header: (n) => req.headers.get(n) }, opts);
  return Response.json(answer.body, { status: answer.status, headers: answer.headers });
}
