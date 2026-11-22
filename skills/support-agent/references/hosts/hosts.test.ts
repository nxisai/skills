/**
 * hosts/hosts.test.ts — the docker and cloudrun profiles' server and stores (vitest), in process.
 *
 * The node:http server (docker/node-server.ts) on a real port, with a scripted model, stub records
 * and a gap sink that takes its time, so the checks see what a relay would: the routes and their
 * refusals, the card's origin, health with and without the token, a turn's response held until its
 * own gap report has gone, and shutdown waiting for reports still out. The Firestore store
 * (cloudrun/firestore-store.ts) over an in-memory fake of the client's collection/doc calls.
 *
 * The cloudflare profile's tests are cloudflare/worker.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import { Task as SdkTask } from '@a2a-js/sdk';
import { HANDOFF_EXTENSION, gapKey, memoryContext, turnRef, type GapReport, type SupportContext } from '../support-core';
import { exampleSite, fileTurns, findGapQuestion, findTurn } from '../example-site';
import { CONNECT_ONLY, emptyRecords, followUpMessage, memoryTurnStore, notFoundModel, slowSink, streamingMessage } from './test-fakes';
import { CARD, HEALTH, PATH, WELL_KNOWN, supportNodeHost, type NodeHost, type NodeHostOptions } from './docker/node-server';
import { STALE_WORKING_MS, findGapQuestionIn, findTurnIn, firestoreStores, type FirestoreDb } from './cloudrun/firestore-store';

const TOKEN = 'relay-token-0123456789abcdef0123456789';
const SECRET = 'turn-secret-0123456789abcdef0123456789';
const ORIGIN = 'https://help.example';

/** The server-sent events of a response, parsed. */
const events = (raw: string) =>
  raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as { result?: { task?: { id: string }; statusUpdate?: { taskId: string; status: { state: string; message?: { parts: { text?: string }[] } } } } });

/** The handoff's first turn, greeted: the task's id, for the visitor's next message. */
const greeted = async (post: (body: string) => Promise<Response>) => events(await (await post(streamingMessage(CONNECT_ONLY))).text()).find((e) => e.result?.task)!.result!.task!.id;

/** The visitor's question on the turn after the greeting, where a not-found sends its gap report. */
const afterGreeting = async (post: (body: string) => Promise<Response>, text: string) => post(followUpMessage(await greeted(post), text));

// ── The node:http server ────────────────────────────────────────────────────

const running: NodeHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of running.splice(0)) await new Promise((r) => h.server.close(r));
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * A host with the secret and a store, as gap reports need: the file at `turnsFile`, or memory.
 * `noSecret`: a host that never set SUPPORT_TURN_REF_SECRET. `delay` gets the report and the wording
 * the host kept for its question key, which the report itself never holds.
 */
async function start(over: Partial<NodeHostOptions> & { delay?: (r: GapReport, wording: string) => number; turnsFile?: string; noSecret?: boolean } = {}) {
  const kept = memoryTurnStore();
  const wordingOf = (r: GapReport) => (r.kind === 'gap' ? (kept.questions.get(r.gap.question_key) ?? '') : '');
  const { sink, reports } = slowSink((r) => (over.delay ?? (() => 300))(r, wordingOf(r)));
  const site =
    over.site ??
    exampleSite({ records: emptyRecords, gaps: sink, ...(over.noSecret ? { turns: null } : { turns: over.turnsFile ? fileTurns(over.turnsFile) : kept.store, turnRefSecret: SECRET }) });
  const host = supportNodeHost({
    site,
    model: notFoundModel,
    modelName: 'scripted',
    tasks: new InMemoryTaskStore(),
    context: memoryContext(),
    store: { name: 'memory', ping: async () => {} },
    relayToken: TOKEN,
    publicOrigin: ORIGIN,
    card: { name: 'Ridgeline Help', description: 'Answers questions.', organization: 'Ridgeline Air', examples: ['How do I replace the filter?'] },
    log: () => {},
    ...over,
  });
  running.push(host);
  await new Promise<void>((r) => host.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  const post = (body: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    fetch(`${base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'a2a-version': '1.0', 'a2a-extensions': HANDOFF_EXTENSION, ...headers }, body });
  return { host, base, post, reports, kept };
}

describe('docker: routes', () => {
  it('serves the card from PUBLIC_ORIGIN, whatever the Host header says, on both paths', async () => {
    const { base } = await start();
    for (const path of [CARD, WELL_KNOWN]) {
      const res = await fetch(`${base}${path}`, { headers: { host: 'evil.example' } });
      expect(res.status).toBe(200);
      const card = (await res.json()) as { supportedInterfaces: { url: string }[]; name: string };
      expect(card.supportedInterfaces[0].url).toBe(`${ORIGIN}${PATH}`);
      expect(card.name).toBe('Ridgeline Help');
    }
  });

  it('leaves /.well-known to another agent when told to', async () => {
    const { base } = await start({ wellKnown: false });
    expect((await fetch(`${base}${WELL_KNOWN}`)).status).toBe(404);
    expect((await fetch(`${base}${CARD}`)).status).toBe(200);
  });

  it('says only whether it is available without the token, and the setup with it', async () => {
    const { base } = await start();
    for (const path of ['/healthz', HEALTH]) {
      const anon = await fetch(`${base}${path}`);
      expect(anon.status).toBe(200);
      expect(await anon.json()).toEqual({ available: true });
      const relay = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(await relay.json()).toEqual({ available: true, model: 'scripted', store: 'memory', corpus: true, gaps: true, helpful: true, turnRefs: true });
    }
  });

  it('without the secret: available, gap reports off, thumbs-up counts still on, and a not-found sends nothing', async () => {
    const { base, post, reports } = await start({ noSecret: true, delay: () => 10 });
    const relay = await fetch(`${base}${HEALTH}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await relay.json()).toEqual({ available: true, model: 'scripted', store: 'memory', corpus: true, gaps: false, helpful: true, turnRefs: false });
    const final = events(await (await post(streamingMessage('Does the X200 work with solar panels?'))).text()).map((e) => e.result?.statusUpdate).filter(Boolean).pop()!;
    expect(final.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(reports).toEqual([]);
  });

  it('is unavailable without a model, and 503 when the store is down', async () => {
    const noModel = await start({ model: null });
    expect(await (await fetch(`${noModel.base}/healthz`)).json()).toEqual({ available: false });
    const down = await start({ store: { name: 'firestore', ping: async () => Promise.reject(new Error('down')) } });
    const res = await fetch(`${down.base}/healthz`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ available: false, store: 'firestore unreachable' });
  });

  it('refuses: unknown paths, other methods, no token, a wrong token, a body over 64 KB', async () => {
    const { base, post } = await start();
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
    expect((await fetch(`${base}${PATH}`)).status).toBe(405);
    expect((await post('{}', {})).status).toBe(403);
    expect((await post('{}', { authorization: 'Bearer nope' })).status).toBe(403);
    expect((await post('{}', { authorization: `Bearer ${TOKEN}x` })).status).toBe(403);
    expect((await post('a'.repeat(70_000))).status).toBe(413);
  });
});

describe('docker: gap reports and the response', () => {
  it('holds the response until its turn has saved the turn and sent the report, after the reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'support-hosts-'));
    dirs.push(dir);
    const file = join(dir, 'turns.jsonl');
    const { post, reports } = await start({ turnsFile: file, delay: () => 400 });
    const taskId = await greeted(post);
    const started = Date.now();
    const res = await post(followUpMessage(taskId, 'Does the X200 work with solar panels?'));
    const raw = await res.text();
    const ended = Date.now();
    const final = events(raw).map((e) => e.result?.statusUpdate).filter(Boolean).pop()!;
    expect(final.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    // The report landed before the response ended, and the response waited for it.
    expect(reports).toHaveLength(1);
    expect(reports[0].at).toBeLessThanOrEqual(ended);
    expect(ended - started).toBeGreaterThanOrEqual(400);
    const gap = reports[0].report as Extract<GapReport, { kind: 'gap' }>;
    expect(gap.gap.outcome).toBe('not_found');
    const reply = final.status.message!.parts.map((p) => p.text ?? '').filter(Boolean).join('\n\n');
    const ref = turnRef(SECRET, 'Does the X200 work with solar panels?', reply);
    expect(gap.gap.ref).toBe(ref);
    expect(await findTurn(file, ref)).toMatchObject({ ref, prompt: 'Does the X200 work with solar panels?', reply });
    // The question went as its key; its wording is in the file, and in nothing that was sent.
    expect(gap.gap.question_key).toBe(gapKey(SECRET, 'does the x200 work with solar panels'));
    expect(await findGapQuestion(file, gap.gap.question_key)).toMatchObject({ key: gap.gap.question_key, question: 'does the x200 work with solar panels' });
    expect(JSON.stringify(reports).toLowerCase()).not.toMatch(/solar|"question"/);
  });

  it("holds each response for its own turn's reports only", async () => {
    const { post, reports } = await start({ delay: (_r, wording) => (wording.includes('slow') ? 1_200 : 50) });
    const timed = async (text: string) => {
      const t = Date.now();
      await (await afterGreeting(post, text)).text();
      return Date.now() - t;
    };
    const [slow, fast] = await Promise.all([timed('Does the slow model fit?'), timed('Does the X200 fit a shelf?')]);
    expect(slow).toBeGreaterThanOrEqual(1_200);
    expect(fast).toBeLessThan(1_000);
    expect(reports).toHaveLength(2);
  });

  it('lets a response go after reportWaitMs, and shutdown waits for the report still out', async () => {
    const { host, post, reports } = await start({ reportWaitMs: 50, delay: () => 800 });
    const t = Date.now();
    await (await afterGreeting(post, 'Does the X200 work with solar panels?')).text();
    expect(Date.now() - t).toBeLessThan(700);
    expect(reports).toHaveLength(0);
    await host.shutdown(5_000);
    expect(reports).toHaveLength(1);
    running.splice(running.indexOf(host), 1);
  });

  it('shutdown waits for a turn in flight and its report, then stops listening', async () => {
    const { host, post, reports, base } = await start({ delay: () => 300 });
    const taskId = await greeted(post);
    const turn = post(followUpMessage(taskId, 'Does the X200 work with solar panels?')).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 30));
    await host.shutdown(5_000);
    expect(events(await turn).length).toBeGreaterThan(0);
    expect(reports).toHaveLength(1);
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    running.splice(running.indexOf(host), 1);
  });

  it('gives up on a report at the grace period', async () => {
    const { host, post, reports } = await start({ reportWaitMs: 10, delay: () => 3_000 });
    await (await post(streamingMessage('Does the X200 work with solar panels?'))).text();
    const t = Date.now();
    await host.shutdown(200);
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(reports).toHaveLength(0);
    running.splice(running.indexOf(host), 1);
  });
});

// ── Firestore, over an in-memory fake ───────────────────────────────────────

/** The collection/doc calls firestore-store.ts makes, over a Map. `create` fails if the document exists, as Firestore's does. */
function fakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const db = {
    collection: (c: string) => ({
      doc: (id: string) => {
        const key = `${c}/${id}`;
        const snap = () => {
          const data = docs.get(key);
          return { exists: !!data, get: (f: string) => data?.[f], data: () => (data ? structuredClone(data) : undefined) };
        };
        return {
          get: async () => snap(),
          set: async (data: Record<string, unknown>) => void docs.set(key, structuredClone(data)),
          delete: async () => void docs.delete(key),
        };
      },
    }),
  };
  return { db: db as unknown as FirestoreDb, docs };
}

describe('cloudrun: the Firestore store', () => {
  /** The SDK's per-call context, which these stores don't read. */
  const CALL = {} as never;
  const stateOf = (t: SdkTask | undefined) => (t ? (SdkTask.toJSON(t) as { status?: { state?: string } }).status?.state : undefined);
  const task = (state: string, timestamp: string) => SdkTask.fromJSON({ id: 't1', contextId: 'c1', status: { state, timestamp }, history: [] });

  it('keeps tasks, context, turns and questions in their collections, each with an expireAt', async () => {
    const { db, docs } = fakeFirestore();
    const s = firestoreStores(db, { turnRetentionDays: 7 });
    await s.tasks.save(task('TASK_STATE_INPUT_REQUIRED', new Date().toISOString()), CALL);
    expect(stateOf(await s.tasks.load('t1', CALL))).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(await s.tasks.load('nope', CALL)).toBeUndefined();

    const ctx: SupportContext = { turns: 1, exchanges: [{ question: 'x200 solar', cited: [], outcome: 'not_found' }], records: {}, answers: [] };
    expect(await s.context.get('t1')).toBeNull();
    await s.context.set('t1', ctx);
    expect(await s.context.get('t1')).toEqual(ctx);
    await s.context.delete('t1');
    expect(await s.context.get('t1')).toBeNull();

    const ref = turnRef(SECRET, 'Q?', 'A.');
    await s.turns.save(ref, { prompt: 'Q?', reply: 'A.', at: new Date().toISOString() });
    expect(await findTurnIn(db, ref)).toMatchObject({ ref, prompt: 'Q?', reply: 'A.' });
    expect(await findTurnIn(db, 'missing')).toBeNull();

    // A gap question's wording, under its key: asked again, the first time stays and the last moves on.
    const key = gapKey(SECRET, 'x200 solar');
    expect(await findGapQuestionIn(db, key)).toBeNull();
    await s.turns.saveQuestion(key, { question: 'x200 solar', at: '2026-11-08T10:00:00.000Z' });
    await s.turns.saveQuestion(key, { question: 'x200 solar', at: '2026-11-10T09:00:00.000Z' });
    expect(await findGapQuestionIn(db, key)).toEqual({ key, question: 'x200 solar', firstSeen: '2026-11-08T10:00:00.000Z', lastSeen: '2026-11-10T09:00:00.000Z' });
    const questionExpiry = (docs.get(`support-questions/${key}`)!.expireAt as Date).getTime() - Date.now();
    expect(questionExpiry).toBeGreaterThan(6.9 * 86_400_000);
    expect(questionExpiry).toBeLessThan(7.1 * 86_400_000);

    const turnExpiry = (docs.get(`support-turns/${ref}`)!.expireAt as Date).getTime() - Date.now();
    expect(turnExpiry).toBeGreaterThan(6.9 * 86_400_000);
    expect(turnExpiry).toBeLessThan(7.1 * 86_400_000);
    expect(docs.get('support-tasks/t1')!.expireAt).toBeInstanceOf(Date);
    expect([...docs.keys()].sort()).toEqual([`support-questions/${key}`, `support-tasks/t1`, `support-turns/${ref}`]);
  });

  it('fails a task left working longer than a turn takes, and leaves a fresh one', async () => {
    const { db } = fakeFirestore();
    const s = firestoreStores(db);
    await s.tasks.save(task('TASK_STATE_WORKING', new Date().toISOString()), CALL);
    await s.failStale('t1');
    expect(stateOf(await s.tasks.load('t1', CALL))).toBe('TASK_STATE_WORKING');
    await s.tasks.save(task('TASK_STATE_WORKING', new Date(Date.now() - STALE_WORKING_MS - 1_000).toISOString()), CALL);
    await s.failStale('t1');
    expect(stateOf(await s.tasks.load('t1', CALL))).toBe('TASK_STATE_FAILED');
    await s.failStale('missing');
  });

  it('bounds a call that hangs, so a turn fails rather than waits', async () => {
    const hung = { collection: () => ({ doc: () => ({ get: () => new Promise(() => {}) }) }) } as unknown as FirestoreDb;
    await expect(firestoreStores(hung).ping()).rejects.toThrow(/timed out/);
  }, 5_000);

  it('serves a conversation across two instances sharing one store', async () => {
    const { db } = fakeFirestore();
    const { sink, reports } = slowSink(() => 10);
    const s = firestoreStores(db);
    const site = exampleSite({ records: emptyRecords, gaps: sink, turns: s.turns, turnRefSecret: SECRET });
    const two = await Promise.all(
      [0, 1].map(() =>
        start({ site, tasks: s.tasks, context: s.context, beforeRead: s.failStale, store: { name: 'firestore', ping: s.ping } }),
      ),
    );
    const first = events(await (await two[0].post(streamingMessage('Does the X200 work with solar panels?'))).text());
    const taskId = first.find((e) => e.result?.task)!.result!.task!.id;
    // The follow-up, on the other instance: it finds the task and its context.
    const follow = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SendStreamingMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', taskId, parts: [{ text: 'And with a battery?' }] } } });
    const second = events(await (await two[1].post(follow)).text());
    expect(second.some((e) => e.result?.statusUpdate?.status.state === 'TASK_STATE_INPUT_REQUIRED')).toBe(true);
    expect((await s.context.get(taskId))?.turns).toBe(2);
    // The first turn, the handoff's, is greeted when it finds nothing: the follow-up's not-found is the one report.
    expect(reports.length).toBe(1);
    for (const r of reports) {
      const { gap } = r.report as Extract<GapReport, { kind: 'gap' }>;
      expect(await findTurnIn(db, gap.ref!)).not.toBeNull();
      expect((await findGapQuestionIn(db, gap.question_key))?.question).toMatch(/x200|battery/);
    }
  });
});

// The JSON Lines file a docker volume holds is example-site's fileTurns; its own tests are in support-agent.test.ts.
it('docker: the turns file is readable by its owner only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'support-hosts-'));
  dirs.push(dir);
  const file = join(dir, 'turns.jsonl');
  await fileTurns(file).save('r', { prompt: 'p', reply: 'r', at: 'now' });
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ ref: 'r', prompt: 'p' });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
