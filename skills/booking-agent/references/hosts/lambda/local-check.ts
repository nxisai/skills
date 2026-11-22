/**
 * hosts/lambda/local-check.ts — the Lambda handler, invoked locally with
 * synthetic Function URL events, against DynamoDB Local and a stub sink, with a
 * scripted model. Nothing here touches AWS: it refuses to run unless
 * DYNAMODB_ENDPOINT is on localhost, and uses dummy credentials.
 *
 *   docker run -d --rm --name booking-ddb-local -p 127.0.0.1:8765:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://127.0.0.1:8765 npx tsx local-check.ts
 *   docker rm -f booking-ddb-local
 *
 * Checks: both cards point at PUBLIC_ORIGIN; no or a wrong token → 403; an
 * oversized body → 413; a scripted conversation (the example calendar's offer,
 * a pick, the details, the summary, a yes) reaches exactly one booking with the
 * sink's reference; two "yes" invocations at once, from two separate Node
 * processes (two "containers"), → exactly one booking; and 20 concurrent claims
 * on one attempt → exactly one true, while the next attempt's key is free.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { addDays, wallClock, type BookingDecision, type BookingModel } from '../../agent-core';
import { RULES, exampleSite, memoryAvailability, webhookSink } from '../../example-site';

const DDB = process.env.DYNAMODB_ENDPOINT ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(DDB)) throw new Error('Set DYNAMODB_ENDPOINT to DynamoDB Local (http://127.0.0.1:<port>). This check never calls AWS.');
const SINK_PORT = Number(process.env.SINK_PORT ?? 4237);
const TOKEN = 'local-relay-token';

// Before the handler loads: local table, local sink, dummy credentials (never the machine's own).
Object.assign(process.env, {
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_PROFILE: '',
  BOOKING_TABLE: 'booking-agent-local',
  PUBLIC_ORIGIN: 'https://northside.example',
  BOOKING_SINK_URL: `http://127.0.0.1:${SINK_PORT}/api/book`,
});
delete process.env.BOOKING_SECRETS_PREFIX;

/** Test-only: a model that passes the service and a day, then the contact details once they are given. Never a real key. */
const DAY = addDays(wallClock(Date.now(), RULES.timeZone).date, 2);
const scripted: BookingModel = {
  async decide({ messages }): Promise<BookingDecision> {
    const said = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const base = { service: 'drain-cleaning', date: DAY };
    if (!/pat@example\.com/.test(said)) return { action: 'details', values: base };
    return { action: 'details', values: { ...base, full_name: 'Pat Doe', phone: '773-555-0100', email: 'pat@example.com', street: '5100 N Milwaukee Ave', zip: '60630' } };
  },
};

const { handler, progressStore, useBookingAgent } = await import('./handler');
// The example calendar, in memory: each process has its own, and each finds the slot free at the yes. The claim, in DynamoDB, is what stops a double booking.
const site = exampleSite({
  availability: memoryAvailability(),
  sink: webhookSink({ url: () => process.env.BOOKING_SINK_URL!, secret: 'local-signing-secret', timeZone: RULES.timeZone }),
});
useBookingAgent({ model: scripted, site, secrets: { relayToken: TOKEN, webhookSigningSecret: 'local-signing-secret', anthropicApiKey: undefined } });

// ── Synthetic Function URL events ───────────────────────────────────────────

function event(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): LambdaFunctionURLEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'abc123.lambda-url.us-east-1.on.aws', 'content-type': 'application/json', ...headers },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'abc123',
      domainName: 'abc123.lambda-url.us-east-1.on.aws',
      domainPrefix: 'abc123',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'local-check' },
      requestId: crypto.randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
    },
    body: body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64'),
    isBase64Encoded: body !== undefined,
  };
}

const relay = { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'a2a-version': '1.0', 'a2a-extensions': 'https://nxis.ai/a2a/handoff/v1' };
const rpc = (text: string | null, taskId?: string, contextId?: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'SendStreamingMessage',
  params: {
    message: {
      messageId: crypto.randomUUID(),
      role: 'ROLE_USER',
      ...(taskId ? { taskId, contextId } : {}),
      parts: text
        ? [{ text }]
        : [{ data: { handoff: 'envelope', reason: 'booking', summary: 'Kitchen drain is slow; wants someone to come and clear it.', page: { url: 'https://northside.example/', title: 'Northside Plumbing' } }, mediaType: 'application/json', metadata: { extension: 'https://nxis.ai/a2a/handoff/v1' } }],
    },
    configuration: { acceptedOutputModes: ['text/plain', 'application/json'] },
  },
});

interface Turn {
  status: number;
  type: string;
  taskId?: string;
  contextId?: string;
  state?: string;
  text: string;
  handback?: Record<string, unknown>;
}

/** One relay call: the turn's server-sent events, read for the task, its last state and what the agent said. */
async function send(text: string | null, taskId?: string, contextId?: string): Promise<Turn> {
  const res = await handler(event('POST', '/a2a/booking', rpc(text, taskId, contextId), relay));
  const r = typeof res === 'string' ? { statusCode: 200, body: res, headers: {} } : res;
  const turn: Turn = { status: r.statusCode ?? 200, type: String(r.headers?.['content-type'] ?? ''), text: '' };
  for (const line of (r.body ?? '').split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const result = JSON.parse(line.slice(6)).result ?? {};
    const t = result.task ?? result.statusUpdate;
    if (!t) continue;
    turn.taskId ??= t.id ?? t.taskId;
    turn.contextId ??= t.contextId;
    turn.state = t.status?.state;
    const parts = t.status?.message?.parts ?? [];
    if (parts.length) {
      turn.text = parts.map((p: { text?: string }) => p.text ?? '').join('');
      turn.handback = parts.find((p: { data?: { handoff?: string } }) => p.data?.handoff === 'handback')?.data;
    }
  }
  return turn;
}

// ── Child mode: one "yes" from its own process ──────────────────────────────

if (process.argv[2] === 'yes') {
  const t = await send('yes', process.argv[3], process.argv[4]);
  process.stdout.write(JSON.stringify(t));
  process.exit(0);
}

// ── The checks ──────────────────────────────────────────────────────────────

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const posts: { body: Record<string, string>; signed: boolean }[] = [];
const sink = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    posts.push({ body: JSON.parse(raw), signed: /^t=\d+,v1=[0-9a-f]{64}$/.test(String(req.headers['x-nxis-signature'] ?? '')) });
    const reference = `NB-LOCAL${String(posts.length).padStart(3, '0')}`;
    // A slow sink widens the window in which two "yes" invocations overlap.
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'confirmed', reference }));
    }, 1000);
  });
});
await new Promise<void>((ok) => sink.listen(SINK_PORT, '127.0.0.1', ok));

const ddb = new DynamoDBClient({ endpoint: DDB });
try {
  await ddb.send(
    new CreateTableCommand({
      TableName: 'booking-agent-local',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
} catch (err) {
  if (!(err instanceof ResourceInUseException)) throw err;
}

try {
  for (const path of ['/a2a/booking/agent-card.json', '/.well-known/agent-card.json']) {
    const r = await handler(event('GET', path));
    const card = typeof r === 'string' ? null : JSON.parse(r.body ?? '{}');
    check(`GET ${path}`, typeof r !== 'string' && r.statusCode === 200 && card?.supportedInterfaces?.[0]?.url === 'https://northside.example/a2a/booking', card?.supportedInterfaces?.[0]?.url);
  }

  for (const [name, headers] of [
    ['no Authorization', {}],
    ['wrong token', { authorization: 'Bearer nope' }],
  ] as const) {
    const r = await handler(event('POST', '/a2a/booking', rpc('hi'), headers));
    check(`POST /a2a/booking, ${name} → 403`, typeof r !== 'string' && r.statusCode === 403, String(typeof r !== 'string' && r.statusCode));
  }
  const big = await handler(event('POST', '/a2a/booking', 'x'.repeat(70_000), relay));
  check('POST /a2a/booking, 70 KB body → 413', typeof big !== 'string' && big.statusCode === 413);

  // A conversation to exactly one booking.
  const t1 = await send(null);
  check('envelope → the calendar\'s offer', t1.status === 200 && t1.type.includes('text/event-stream') && t1.state === 'TASK_STATE_INPUT_REQUIRED' && /\n1\. /.test(t1.text) && /Chicago time/.test(t1.text), `${t1.state}: ${t1.text}`);
  const t1b = await send('1', t1.taskId, t1.contextId);
  check('a pick → the first detail asked for', t1b.state === 'TASK_STATE_INPUT_REQUIRED' && t1b.text === 'What name should the booking be under?', t1b.text);
  const t2 = await send('Pat Doe, 773-555-0100, pat@example.com, 5100 N Milwaukee Ave 60630', t1.taskId, t1.contextId);
  check('details → the summary', t2.state === 'TASK_STATE_INPUT_REQUIRED' && t2.text.startsWith("Here's the booking with Northside Plumbing"), t2.text.split('\n')[0]);
  const t3 = await send('yes', t1.taskId, t1.contextId);
  const ref = (t3.handback?.references as { value: string }[] | undefined)?.[0]?.value;
  check('yes → resolved, the sink reference', t3.state === 'TASK_STATE_COMPLETED' && t3.handback?.outcome === 'resolved' && ref === 'NB-LOCAL001', t3.text);
  check('exactly one booking, signed, the form payload', posts.length === 1 && posts[0].signed && posts[0].body.service === 'drain-cleaning' && posts[0].body.time_zone === 'America/Chicago' && posts[0].body.email === 'pat@example.com', JSON.stringify(posts[0]?.body));

  // Two concurrent "yes" from two processes → one booking.
  const before = posts.length;
  const u1 = await send(null);
  await send('1', u1.taskId, u1.contextId);
  const u2 = await send('Pat Doe, 773-555-0100, pat@example.com, 5100 N Milwaukee Ave 60630', u1.taskId, u1.contextId);
  check('second task at its summary', u2.text.startsWith("Here's the booking"));
  const self = fileURLToPath(import.meta.url);
  const child = () =>
    new Promise<Turn>((ok, fail) => {
      const p = spawn(process.execPath, ['--import', 'tsx', self, 'yes', u1.taskId!, u1.contextId!], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.on('exit', (code) => (code === 0 ? ok(JSON.parse(out)) : fail(new Error(`child exited ${code}`))));
    });
  const [a, b] = await Promise.all([child(), child()]);
  check('two concurrent yes → exactly one booking', posts.length - before === 1, `${posts.length - before} booking(s)`);
  check('both resolved with the reference; one "already made"', [a, b].every((t) => t.handback?.outcome === 'resolved') && [a, b].every((t) => /NB-LOCAL/.test(t.text)) && [a, b].some((t) => /already been made/.test(t.text)), `${a.text} | ${b.text}`);

  // The claim itself, 20 at once on one attempt; the next attempt has a key of its own.
  const id = crypto.randomUUID();
  const wins = await Promise.all(Array.from({ length: 20 }, () => progressStore.claim(`${id}.0`)));
  check('20 concurrent claims on one attempt → exactly one true', wins.filter(Boolean).length === 1, `${wins.filter(Boolean).length} true`);
  check('the next attempt claims afresh', (await progressStore.claim(`${id}.1`)) === true);
} finally {
  sink.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
