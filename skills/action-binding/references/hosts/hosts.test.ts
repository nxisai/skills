/**
 * hosts/hosts.test.ts — every host file, driven with calls signed the way
 * NxisAI signs them (vitest, in one process, no network beyond localhost).
 * The Next.js, Netlify, Vercel and Workers handlers are called with a web
 * Request; Express and Fastify run on a local port and are called over HTTP.
 * submissions.ts is replaced by spies, so a test sees exactly what was
 * delivered and what was only checked. Bookings (bookings.ts) are driven
 * through receive() on a clock the test sets: open counts, holds issued,
 * honored and expired, a commit without a hold, a taken window.
 *
 * Copy it with the files it tests, then: npx vitest run hosts.test.ts
 * (it needs express and fastify installed only for node.ts; delete that
 * part if the project uses neither).
 */
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import Fastify from 'fastify';

vi.mock('./submissions', async (importActual) => {
  const actual = await importActual<typeof import('./submissions')>();
  return {
    ...actual,
    deliver: vi.fn(async () => ({ reference: `REF-${Math.random().toString(36).slice(2, 8).toUpperCase()}` })),
    check: vi.fn(async () => ({ available: true })),
  };
});

import { memoryStore, receive, signatureHeader, verifySignature, type ReceiverOptions } from './receiver';
import { bookingCalendar, memorySlotStore } from './bookings';
import * as submissions from './submissions';
import * as nextjs from './nextjs';
import netlify from './netlify';
import * as vercel from './vercel';
import cloudflare from './cloudflare';
import { nxisActionPlugin, nxisActionRouter } from './node';

const SECRET = 'test-secret-for-the-receiver';
const PREVIOUS = 'the-secret-before-a-rotation';
const deliver = vi.mocked(submissions.deliver);
const check = vi.mocked(submissions.check);
const now = () => Math.floor(Date.now() / 1000);

type Call = (req: Request) => Promise<Response>;
const servers: { close(): unknown }[] = [];
let expressUrl = '';
let fastifyUrl = '';

/** Forward a web Request to a local server, keeping the exact body bytes. */
const over = (base: () => string): Call => async (req) => {
  const url = new URL(req.url);
  const body = req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : undefined;
  return fetch(`${base()}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
};

const HOSTS: [string, Call][] = [
  ['nextjs (App Router route handler)', (req) => nextjs.POST(req)],
  ['netlify (Functions v2)', (req) => netlify(req)],
  ['vercel (Functions, web signature)', (req) => vercel.POST(req)],
  ['cloudflare (Worker)', (req) => cloudflare.fetch(req, { NXIS_ACTION_SECRET: SECRET, NXIS_ACTION_SECRET_PREVIOUS: PREVIOUS })],
  ['express', over(() => expressUrl)],
  ['fastify', over(() => fastifyUrl)],
];

beforeAll(async () => {
  process.env.NXIS_ACTION_SECRET = SECRET;
  process.env.NXIS_ACTION_SECRET_PREVIOUS = PREVIOUS;

  // As a real app is wired: the receiver first, JSON parsing for everything else after it.
  const app = express();
  app.use(nxisActionRouter());
  app.use(express.json());
  app.post('/api/other', (req, res) => res.json({ parsed: req.body }));
  await new Promise<void>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      expressUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
    servers.push(server);
  });

  const fastify = Fastify();
  await fastify.register(nxisActionPlugin);
  fastify.post('/api/other', async (req) => ({ parsed: req.body }));
  fastifyUrl = await fastify.listen({ port: 0, host: '127.0.0.1' });
  servers.push(fastify);
});

afterAll(async () => {
  for (const s of servers) await s.close();
});

beforeEach(() => {
  deliver.mockClear();
  check.mockClear();
});

const quote = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ service: 'Drain cleaning', name: 'Pat Kowalski', email: 'pat@example.com', ...extra });

async function signed(
  body: string,
  {
    secret = SECRET,
    t = now(),
    sendBody = body,
    headers = {} as Record<string, string>,
    key = crypto.randomUUID(),
    action = 'quote',
  } = {},
): Promise<Request> {
  return new Request(`https://example.com/api/nxis/action?action=${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nxis-signature': await signatureHeader(secret, t, body),
      'idempotency-key': key,
      ...headers,
    },
    body: sendBody,
  });
}

describe('the signature format', () => {
  it('is HMAC-SHA256(secret, "<t>.<raw body>") in lowercase hex, as t=…,v1=…', async () => {
    const body = '{"name":"Zoë","note":"café ☕"}';
    const t = 1_763_900_000;
    const expected = createHmac('sha256', SECRET).update(`${t}.${body}`, 'utf8').digest('hex');
    expect(await signatureHeader(SECRET, t, body)).toBe(`t=${t},v1=${expected}`);
    expect(await verifySignature(`t=${t},v1=${expected}`, new TextEncoder().encode(body), [SECRET], t)).toEqual({ ok: true, signature: expected });
  });

  it('refuses a header with no t or no v1, and a missing secret', async () => {
    const t = now();
    expect((await verifySignature(`v1=${'a'.repeat(64)}`, '{}', [SECRET], t)).ok).toBe(false);
    expect((await verifySignature(`t=${t}`, '{}', [SECRET], t)).ok).toBe(false);
    expect((await verifySignature(await signatureHeader(SECRET, t, '{}'), '{}', [], t)).ok).toBe(false);
  });
});

describe.each(HOSTS)('%s', (_name, call) => {
  it('takes a correctly signed commit, and delivers it once', async () => {
    const res = await call(await signed(quote()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('confirmed');
    expect(body.confirmation_id).toMatch(/^REF-/);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ args: { name: 'Pat Kowalski' }, action: 'quote' });
    expect(check).not.toHaveBeenCalled();
  });

  it('takes one signed with the previous secret, during a rotation', async () => {
    expect((await call(await signed(quote(), { secret: PREVIOUS }))).status).toBe(200);
  });

  it('refuses a tampered body', async () => {
    const res = await call(await signed(quote(), { sendBody: quote({ email: 'attacker@example.com' }) }));
    expect(res.status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses a body re-serialized after parsing (the raw-body mistake)', async () => {
    const raw = '{ "name": "Pat",  "service": "Drain cleaning" }';
    const res = await call(await signed(raw, { sendBody: JSON.stringify(JSON.parse(raw)) }));
    expect(res.status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses the wrong secret', async () => {
    const res = await call(await signed(quote(), { secret: 'not-the-secret' }));
    expect(res.status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses an old timestamp, and one from the future', async () => {
    expect((await call(await signed(quote(), { t: now() - 600 }))).status).toBe(401);
    expect((await call(await signed(quote(), { t: now() + 600 }))).status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses a call with no signature', async () => {
    const req = new Request('https://example.com/api/nxis/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: quote() });
    expect((await call(req)).status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('answers a check ("nxis:mode": "check") without committing anything', async () => {
    const res = await call(await signed(quote({ 'nxis:mode': 'check' }), { headers: { 'x-nxis-mode': 'check' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, alternatives: [] });
    expect(check).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('treats the X-Nxis-Mode: check header alone as a check too', async () => {
    const res = await call(await signed(quote(), { headers: { 'x-nxis-mode': 'check' } }));
    expect(res.status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers a retried Idempotency-Key once, and answers the repeat with the first reference', async () => {
    const key = crypto.randomUUID();
    const body = quote();
    const first = await call(await signed(body, { key }));
    const second = await call(await signed(body, { key, t: now() - 1 }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect((await second.json()).confirmation_id).toBe((await first.json()).confirmation_id);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('refuses the same Idempotency-Key with a different body', async () => {
    const key = crypto.randomUUID();
    expect((await call(await signed(quote(), { key }))).status).toBe(200);
    expect((await call(await signed(quote({ name: 'Someone Else' }), { key }))).status).toBe(422);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('answers a taken slot with 409 and its alternatives', async () => {
    deliver.mockResolvedValueOnce({ conflict: 'That window is fully booked.', alternatives: [{ date: '2026-12-01' }] });
    const res = await call(await signed(quote()));
    expect(res.status).toBe(409);
    expect((await res.json()).alternatives).toEqual([{ date: '2026-12-01' }]);
  });

  it('confirms nothing while deliver() is unwritten', async () => {
    deliver.mockImplementationOnce(async () => {
      throw new submissions.NotConfigured();
    });
    const res = await call(await signed(quote()));
    expect(res.status).toBe(501);
    expect((await res.json()).confirmation_id).toBeUndefined();
  });

  it('answers a booking check with open windows and a hold, and books the held window', async () => {
    const checked = async (args: Record<string, unknown>) => {
      const res = await call(await signed(JSON.stringify({ ...args, 'nxis:mode': 'check' }), { action: 'booking' }));
      expect(res.status).toBe(200);
      return res.json();
    };
    const listed = await checked({ service: 'Drain cleaning' });
    expect(listed.available).toBe(true);
    expect(listed.windows.length).toBeGreaterThan(0);
    const first = listed.windows[0];
    expect(first).toMatchObject({ start: expect.any(String), end: expect.any(String), open: expect.any(Number) });
    expect(listed.hold).toBeUndefined();

    const one = await checked({ service: 'Drain cleaning', start: first.start });
    expect(one.windows[0].open).toBe(first.open - 1);
    expect(one.hold).toMatchObject({ token: expect.any(String), expires_at: expect.any(String) });
    expect(deliver).not.toHaveBeenCalled();

    const res = await call(await signed(JSON.stringify({ service: 'Drain cleaning', name: 'Pat', hold_token: one.hold.token }), { action: 'booking' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'confirmed', start: first.start });
    expect(deliver.mock.calls[0][0].booking).toEqual({ start: first.start, end: first.end, held: true });
  });

  it('refuses a body over the cap', async () => {
    const big = quote({ notes: 'x'.repeat(70 * 1024) });
    expect((await call(await signed(big))).status).toBe(413);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('the Node servers keep parsing JSON elsewhere', () => {
  it.each([
    ['express', () => expressUrl],
    ['fastify', () => fastifyUrl],
  ])('%s', async (_name, base) => {
    const res = await fetch(`${base()}/api/other`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(await res.json()).toEqual({ parsed: { a: 1 } });
  });
});

describe('availability and holds (bookings.ts)', () => {
  // Monday 30 November 2026, 6:00 in Chicago. The example calendar: weekdays
  // 8 to 12 and 12 to 4, two seats each, five-minute holds, an hour's notice.
  const START = Date.parse('2026-11-30T12:00:00Z');
  const MORNING = '2026-11-30T08:00:00-06:00';
  const AFTERNOON = '2026-11-30T12:00:00-06:00';
  let clock = START;
  let opts: ReceiverOptions;

  beforeEach(() => {
    clock = START;
    opts = {
      secrets: [SECRET],
      store: memoryStore(),
      deliver: submissions.deliver,
      check: submissions.check,
      bookings: bookingCalendar({ ...submissions.calendar, store: memorySlotStore(), now: () => clock }),
      nowSeconds: () => Math.floor(clock / 1000),
    };
  });

  async function post(args: Record<string, unknown>, { mode = '', key = crypto.randomUUID() as string, secret = SECRET, sign = true } = {}) {
    const body = JSON.stringify(mode ? { ...args, 'nxis:mode': mode } : args);
    const t = Math.floor(clock / 1000);
    const headers: Record<string, string> = { 'idempotency-key': key, ...(mode ? { 'x-nxis-mode': mode } : {}) };
    if (sign) headers['x-nxis-signature'] = await signatureHeader(secret, t, body);
    return receive(
      { method: 'POST', url: 'https://example.com/api/nxis/action?action=booking', body, header: (n) => headers[n.toLowerCase()] ?? null },
      opts,
    );
  }
  const checkOf = async (args: Record<string, unknown>) => (await post(args, { mode: 'check' })).body as Record<string, any>;
  const book = (args: Record<string, unknown>, key?: string) => post({ service: 'Drain cleaning', name: 'Pat', ...args }, { key });

  it('lists the next open windows with their open counts, and holds nothing', async () => {
    const a = await checkOf({});
    expect(a.available).toBe(true);
    expect(a.windows.slice(0, 2)).toEqual([
      { start: MORNING, end: '2026-11-30T12:00:00-06:00', name: 'morning', open: 2 },
      { start: AFTERNOON, end: '2026-11-30T16:00:00-06:00', name: 'afternoon', open: 2 },
    ]);
    expect(a.hold).toBeUndefined();
    expect((await checkOf({ date: '2026-11-30' })).windows.map((w: { open: number }) => w.open)).toEqual([2, 2]);
  });

  it('counts a booking and a hold against a window', async () => {
    expect((await book({ start: MORNING })).status).toBe(200);
    expect((await checkOf({ date: '2026-11-30' })).windows[0].open).toBe(1);
    await checkOf({ start: MORNING });
    expect((await checkOf({ date: '2026-11-30' })).windows[0].open).toBe(0);
  });

  it('issues a hold for one window, and gives the same visitor the same hold again', async () => {
    const a = await checkOf({ date: '2026-11-30', window: 'morning' });
    expect(a.available).toBe(true);
    expect(a.windows).toEqual([expect.objectContaining({ start: MORNING, open: 1 })]);
    expect(a.hold.expires_at).toBe(new Date(START + 300_000).toISOString());
    clock += 60_000;
    const again = await checkOf({ start: MORNING, hold_token: a.hold.token });
    expect(again.hold).toEqual(a.hold);
    expect(again.windows[0].open).toBe(1);
  });

  it('honors a hold until it expires', async () => {
    const { hold } = await checkOf({ start: MORNING });
    clock += 299_000;
    const res = await book({ hold_token: hold.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'confirmed', start: MORNING });
    expect(vi.mocked(submissions.deliver).mock.calls[0][0].booking).toEqual({ start: MORNING, end: AFTERNOON, held: true });
    // Used: the same hold can't book a second seat.
    const twice = await book({ hold_token: hold.token });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('hold_unknown');
  });

  it('refuses an expired hold cleanly, with what is open instead', async () => {
    const { hold } = await checkOf({ start: MORNING });
    clock += 301_000;
    const res = await book({ hold_token: hold.token });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 'conflict', code: 'hold_expired' });
    expect((res.body.alternatives as unknown[])[0]).toMatchObject({ start: MORNING, open: 2 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses a hold it never issued, or one for another window', async () => {
    const forged = await book({ hold_token: `h1.${Date.parse(MORNING)}.1.${Math.floor(START / 1000) + 300}.${'0'.repeat(32)}` });
    expect(forged.status).toBe(409);
    expect(forged.body.code).toBe('hold_unknown');
    expect((await book({ hold_token: 'not-a-hold' })).body.code).toBe('hold_unknown');
    const { hold } = await checkOf({ start: MORNING });
    expect((await book({ hold_token: hold.token, start: AFTERNOON })).body.code).toBe('hold_unknown');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('books without a hold when the window is open', async () => {
    const res = await book({ date: '2026-11-30', window: '12:00' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'confirmed', start: AFTERNOON });
    expect(vi.mocked(submissions.deliver).mock.calls[0][0].booking).toEqual({ start: AFTERNOON, end: '2026-11-30T16:00:00-06:00', held: false });
  });

  it('answers a taken window with 409 and the next open windows, on a commit and a check', async () => {
    expect((await book({ start: MORNING })).status).toBe(200);
    expect((await book({ start: MORNING })).status).toBe(200);
    const res = await book({ start: MORNING });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 'conflict', code: 'taken', reason: 'That window is fully booked.' });
    expect((res.body.alternatives as unknown[])[0]).toMatchObject({ start: AFTERNOON, open: 2 });
    expect(deliver).toHaveBeenCalledTimes(2);

    const a = await checkOf({ start: MORNING });
    expect(a.available).toBe(false);
    expect(a.hold).toBeUndefined();
    expect(a.windows[0]).toMatchObject({ start: AFTERNOON, open: 2 });
    expect(a.alternatives).toEqual(a.windows);
  });

  it('keeps held seats from a commit without a hold, until the holds expire', async () => {
    await checkOf({ start: MORNING });
    await checkOf({ start: MORNING });
    expect((await book({ start: MORNING })).body.code).toBe('taken');
    clock += 301_000;
    expect((await book({ start: MORNING })).status).toBe(200);
  });

  it('never commits on a check', async () => {
    await checkOf({});
    await checkOf({ date: '2026-11-30' });
    await checkOf({ start: MORNING, name: 'Pat' });
    expect(deliver).not.toHaveBeenCalled();
    // The hold expires and leaves nothing behind.
    clock += 301_000;
    expect((await checkOf({ date: '2026-11-30' })).windows[0].open).toBe(2);
  });

  it('gives a held seat back to its hold when the commit is rejected, so a corrected one goes through', async () => {
    const { hold } = await checkOf({ start: MORNING });
    vi.mocked(submissions.deliver).mockResolvedValueOnce({ rejected: 'Some arguments need attention.', errors: { phone: 'A phone number' } });
    expect((await book({ hold_token: hold.token })).status).toBe(422);
    expect((await book({ hold_token: hold.token, phone: '555-0100' })).status).toBe(200);
  });

  it('books a retried commit once', async () => {
    const key = crypto.randomUUID();
    const first = await book({ start: MORNING }, key);
    const second = await book({ start: MORNING }, key);
    expect(second.headers?.['Idempotent-Replayed']).toBe('true');
    expect(second.body.reference).toBe(first.body.reference);
    expect((await checkOf({ date: '2026-11-30' })).windows[0].open).toBe(1);
  });

  it('answers past, unknown and unreadable windows as unavailable, with alternatives', async () => {
    clock = Date.parse('2026-11-30T15:00:00Z'); // 9:00, the morning has started
    const past = await checkOf({ start: MORNING });
    expect(past).toMatchObject({ available: false, reason: 'That window has started, or is too soon to book.' });
    expect(past.alternatives[0].start).toBe(AFTERNOON);
    expect((await checkOf({ start: '2026-11-30T09:30:00-06:00' })).available).toBe(false);
    expect((await checkOf({ date: '2026-12-05' })).available).toBe(false); // a Saturday
    expect((await checkOf({ date: 'tomorrow' })).errors).toEqual({ date: 'Give the date as YYYY-MM-DD.' });
  });

  it("lets the project's own check refuse first, and passes a quote check's fields through", async () => {
    vi.mocked(submissions.check).mockResolvedValueOnce({ available: false, service_area: false, reason: 'Outside the service area.' });
    expect(await checkOf({ start: MORNING })).toEqual({ available: false, service_area: false, alternatives: [], reason: 'Outside the service area.' });
    vi.mocked(submissions.check).mockResolvedValueOnce({ available: true, service_area: true, fields: ['zip'] });
    const quoted = await receive(
      {
        method: 'POST',
        url: 'https://example.com/api/nxis/action?action=quote',
        body: '{"nxis:mode":"check"}',
        header: (n) =>
          n === 'x-nxis-signature' ? `t=${Math.floor(clock / 1000)},v1=${createHmac('sha256', SECRET).update(`${Math.floor(clock / 1000)}.{"nxis:mode":"check"}`).digest('hex')}` : null,
      },
      opts,
    );
    expect(quoted.body).toEqual({ available: true, alternatives: [], service_area: true, fields: ['zip'] });
  });

  it('keeps the signature rules: an unsigned, tampered or wrongly signed booking is refused before anything runs', async () => {
    expect((await post({ start: MORNING }, { mode: 'check', sign: false })).status).toBe(401);
    expect((await post({ start: MORNING }, { secret: 'not-the-secret' })).status).toBe(401);
    const body = JSON.stringify({ start: MORNING, 'nxis:mode': 'check' });
    const header = await signatureHeader(SECRET, Math.floor(clock / 1000), body);
    const tampered = await receive(
      { method: 'POST', url: 'https://example.com/api/nxis/action?action=booking', body: body.replace('check', 'commit'), header: (n) => (n === 'x-nxis-signature' ? header : null) },
      opts,
    );
    expect(tampered.status).toBe(401);
    expect(check).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect((await checkOf({ date: '2026-11-30' })).windows[0].open).toBe(2);
  });
});
