/**
 * hosts/cloudflare/worker.test.ts — the cloudflare profile's Worker (agent.ts) (vitest), in Node, over fakes:
 * a Durable Object namespace that runs SupportTask in process (arguments and results copied, as
 * over RPC), a KV namespace over a Map, and an ExecutionContext that collects `waitUntil`. It
 * checks the routes and refusals, a turn whose gap report runs under `waitUntil` after the reply,
 * the turn kept in KV with the owner's retention, a follow-up served by another isolate, and the
 * stale-task guard.
 *
 * `cloudflare:workers` is replaced with a stand-in base class; workerd itself is checked with
 * `wrangler dev` (cloudflare.md, "How to prove it").
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { timingSafeEqual } from 'node:crypto';
import { HANDOFF_EXTENSION, gapKey, turnRef, type GapReport, type SupportContext } from '../../support-core';
import { exampleSite } from '../../example-site';
import { CONNECT_ONLY, emptyRecords, followUpMessage, notFoundModel, slowSink, streamingMessage } from '../test-fakes';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const { SupportTask, STALE_WORKING_MS, kvTurns, supportWorker } = await import('./agent');
type Env = import('./agent').Env;

beforeAll(() => {
  // workerd has crypto.subtle.timingSafeEqual; Node has it on node:crypto only.
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a as Uint8Array, b as Uint8Array);
});

const TOKEN = 'relay-token-0123456789abcdef0123456789';
const SECRET = 'turn-secret-0123456789abcdef0123456789';
const ORIGIN = 'https://help.example';

/** One SupportTask per name, as the platform gives one object per id; every call's arguments and result copied, as RPC does. */
function fakeNamespace(env: () => Env) {
  const objects = new Map<string, { kv: Map<string, unknown>; stub: Record<string, (...a: unknown[]) => Promise<unknown>> }>();
  const ns = {
    idFromName: (name: string) => name,
    get(id: string) {
      let o = objects.get(id);
      if (!o) {
        const kv = new Map<string, unknown>();
        const storage = {
          kv: { get: (k: string) => structuredClone(kv.get(k)), put: (k: string, v: unknown) => void kv.set(k, structuredClone(v)), delete: (k: string) => kv.delete(k) },
          setAlarm: async () => {},
          deleteAll: async () => kv.clear(),
        };
        const instance = new SupportTask({ storage } as never, env()) as unknown as Record<string, (...a: unknown[]) => unknown>;
        const stub = new Proxy({} as Record<string, (...a: unknown[]) => Promise<unknown>>, {
          get: (_, m: string) => async (...args: unknown[]) => structuredClone(await instance[m](...args.map((a) => structuredClone(a)))),
        });
        objects.set(id, (o = { kv, stub }));
      }
      return o.stub;
    },
  };
  return { ns, objects };
}

function fakeKv() {
  const entries = new Map<string, { value: string; ttl?: number }>();
  return { kv: { put: async (k: string, value: string, o?: { expirationTtl?: number }) => void entries.set(k, { value, ttl: o?.expirationTtl }), get: async (k: string, type?: 'json') => { const v = entries.get(k)?.value ?? null; return v !== null && type === 'json' ? JSON.parse(v) : v; } }, entries };
}

function setup(over: Partial<Env> = {}) {
  const { sink, reports } = slowSink(() => 200);
  const { kv, entries } = fakeKv();
  let env: Env;
  const { ns, objects } = fakeNamespace(() => env);
  env = { SUPPORT_TASKS: ns as never, SUPPORT_TURNS: kv as never, A2A_RELAY_TOKEN: TOKEN, SUPPORT_TURN_REF_SECRET: SECRET, ...over } as Env;
  const worker = () =>
    supportWorker({
      model: () => notFoundModel,
      site: (e) => exampleSite({ records: emptyRecords, gaps: sink, turns: kvTurns(e.SUPPORT_TURNS as never, 7), turnRefSecret: e.SUPPORT_TURN_REF_SECRET }),
    });
  const call = async (w: ReturnType<typeof worker>, req: Request) => {
    const waits: Promise<unknown>[] = [];
    const res = await w.fetch!(req as never, env, { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {}, props: {} } as never);
    return { res: res as unknown as Response, waits };
  };
  const post = (body: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    new Request(`${ORIGIN}/a2a/support`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'a2a-version': '1.0', 'a2a-extensions': HANDOFF_EXTENSION, ...headers }, body });
  return { env, worker, call, post, reports, entries, objects };
}

const events = (raw: string) =>
  raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as { result?: { task?: { id: string }; statusUpdate?: { status: { state: string; message?: { parts: { text?: string }[] } } } } });

describe('cloudflare: routes', () => {
  it('serves the card for the origin it is reached on, on both paths, and leaves /.well-known when told to', async () => {
    const t = setup();
    const w = t.worker();
    for (const path of ['/a2a/support/agent-card.json', '/.well-known/agent-card.json']) {
      const { res } = await t.call(w, new Request(`${ORIGIN}${path}`));
      expect(((await res.json()) as { supportedInterfaces: { url: string }[] }).supportedInterfaces[0].url).toBe(`${ORIGIN}/a2a/support`);
    }
    const off = setup({ SUPPORT_CARD_WELL_KNOWN: 'false' });
    expect((await off.call(off.worker(), new Request(`${ORIGIN}/.well-known/agent-card.json`))).res.status).toBe(404);
  });

  it('passes other paths to the static assets, when the Worker is the site', async () => {
    const t = setup({ ASSETS: { fetch: async () => new Response('the site') } as never });
    expect(await (await t.call(t.worker(), new Request(`${ORIGIN}/about`))).res.text()).toBe('the site');
  });

  it('says whether it is available, and nothing more', async () => {
    const t = setup();
    const { res } = await t.call(t.worker(), new Request(`${ORIGIN}/a2a/support/healthz`));
    expect(await res.json()).toEqual({ available: true });
    // The default site and model, with no key and an MCP server that can't be reached.
    const bare = setup();
    const { res: r2 } = await bare.call(supportWorker(), new Request(`${ORIGIN}/a2a/support/healthz`));
    expect(await r2.json()).toEqual({ available: false });
  });

  it('refuses: other methods, no token, a wrong one, one of the same length, no secret set, a body over 64 KB', async () => {
    const t = setup();
    const w = t.worker();
    expect((await t.call(w, new Request(`${ORIGIN}/a2a/support`))).res.status).toBe(405);
    expect((await t.call(w, t.post('{}', {}))).res.status).toBe(403);
    expect((await t.call(w, t.post('{}', { authorization: 'Bearer nope' }))).res.status).toBe(403);
    expect((await t.call(w, t.post('{}', { authorization: `Bearer ${TOKEN.slice(0, -1)}x` }))).res.status).toBe(403);
    const unset = setup({ A2A_RELAY_TOKEN: undefined });
    expect((await unset.call(unset.worker(), unset.post('{}', { authorization: 'Bearer ' }))).res.status).toBe(403);
    expect((await t.call(w, t.post('a'.repeat(70_000)))).res.status).toBe(413);
    // No Content-Length: refused while it streams.
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode('a'.repeat(70_000))), c.close()) });
    const chunked = new Request(`${ORIGIN}/a2a/support`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: stream, duplex: 'half' } as RequestInit);
    expect((await t.call(w, chunked)).res.status).toBe(413);
  });
});

describe('cloudflare: a turn', () => {
  it('replies, then sends its gap report under waitUntil, with the turn kept in KV for the retention', async () => {
    const t = setup();
    // The handoff's first turn is greeted; the question is the visitor's next message.
    const greeting = await t.call(t.worker(), t.post(streamingMessage(CONNECT_ONLY)));
    const started = events(await greeting.res.text()).find((e) => e.result?.task)!.result!.task!.id;
    await Promise.all(greeting.waits);
    const { res, waits } = await t.call(t.worker(), t.post(followUpMessage(started, 'Does the X200 work with solar panels?')));
    const raw = await res.text();
    const final = events(raw).map((e) => e.result?.statusUpdate).filter(Boolean).pop()!;
    expect(final.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    // The reply is out; the report is still going, under waitUntil.
    expect(t.reports).toHaveLength(0);
    expect(waits.length).toBeGreaterThan(0);
    await Promise.all(waits);
    expect(t.reports).toHaveLength(1);
    const gap = (t.reports[0].report as Extract<GapReport, { kind: 'gap' }>).gap;
    const reply = final.status.message!.parts.map((p) => p.text ?? '').filter(Boolean).join('\n\n');
    const ref = turnRef(SECRET, 'Does the X200 work with solar panels?', reply);
    expect(gap.ref).toBe(ref);
    const kept = t.entries.get(`turn:${ref}`)!;
    expect(JSON.parse(kept.value)).toMatchObject({ ref, prompt: 'Does the X200 work with solar panels?', reply });
    expect(kept.ttl).toBe(7 * 86_400);
    // The question went as its key; its wording is in KV under it, for the same retention, and in nothing sent.
    expect(gap.question_key).toBe(gapKey(SECRET, 'does the x200 work with solar panels'));
    const wording = t.entries.get(`question:${gap.question_key}`)!;
    expect(JSON.parse(wording.value)).toEqual({ key: gap.question_key, question: 'does the x200 work with solar panels', firstSeen: expect.any(String), lastSeen: expect.any(String) });
    expect(wording.ttl).toBe(7 * 86_400);
    expect(JSON.stringify(t.reports).toLowerCase()).not.toMatch(/solar|"question"/);
    // The task's object holds the task and the context; nothing else does.
    const kv = t.objects.get(started)!.kv;
    expect([...kv.keys()].sort()).toEqual(['context', 'task']);
    expect((kv.get('context') as SupportContext).turns).toBe(2);
  });

  it('serves a follow-up from another isolate, from the context in the task object', async () => {
    const t = setup();
    const first = await t.call(t.worker(), t.post(streamingMessage('Does the X200 work with solar panels?')));
    const taskId = events(await first.res.text()).find((e) => e.result?.task)!.result!.task!.id;
    await Promise.all(first.waits);
    const follow = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SendStreamingMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', taskId, parts: [{ text: 'And with a battery?' }] } } });
    const second = await t.call(t.worker(), t.post(follow));
    expect(events(await second.res.text()).some((e) => e.result?.statusUpdate?.status.state === 'TASK_STATE_INPUT_REQUIRED')).toBe(true);
    expect((t.objects.get(taskId)!.kv.get('context') as SupportContext).turns).toBe(2);
  });

  it('fails a task a cut-off turn left working, on its next read', async () => {
    const t = setup();
    const stub = (t.env.SUPPORT_TASKS as unknown as { get(id: string): Record<string, (...a: unknown[]) => Promise<unknown>> }).get('stale');
    await stub.saveTask({ id: 'stale', contextId: 'c', status: { state: 'TASK_STATE_WORKING', timestamp: new Date(Date.now() - STALE_WORKING_MS - 1_000).toISOString() }, history: [] });
    const { res } = await t.call(t.worker(), t.post(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: 'stale' } }), { authorization: `Bearer ${TOKEN}`, accept: 'application/json' }));
    expect(((await res.json()) as { result: { status: { state: string } } }).result.status.state).toBe('TASK_STATE_FAILED');
  });

  it('keeps question keys and turn references off, and so gap reports, without a long enough secret or the KV binding', async () => {
    for (const over of [{ SUPPORT_TURN_REF_SECRET: 'short' }, { SUPPORT_TURNS: undefined }]) {
      const t = setup(over);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      // The default site, to reach the Worker's own turn-reference settings; health builds it.
      await t.call(supportWorker({ model: () => notFoundModel }), new Request(`${ORIGIN}/a2a/support/healthz`));
      expect(errors.mock.calls.some((c) => String(c[0]).includes('question keys and turn references are off, so no gap reports are sent'))).toBe(true);
      errors.mockRestore();
    }
  });
});
