/**
 * hosts/lambda/local-check.ts — the Lambda handler, invoked locally with
 * synthetic Function URL events, against DynamoDB Local and a stub sink, with a
 * scripted model. Nothing here touches AWS: it refuses to run unless
 * DYNAMODB_ENDPOINT is on localhost, and uses dummy credentials.
 *
 *   docker run -d --rm --name quote-ddb-local -p 127.0.0.1:8765:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://127.0.0.1:8765 npx tsx local-check.ts
 *   docker rm -f quote-ddb-local
 *
 * Checks: both cards point at PUBLIC_ORIGIN; no or a wrong token → 403; an
 * oversized body → 413; a scripted conversation reaches exactly one submission
 * with the sink's reference; two "yes" invocations at once, from two separate
 * Node processes (two "containers"), → exactly one submission; and 20
 * concurrent claims on one task → exactly one true, and progress then reads
 * as submitted.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import type { QuoteDecision, QuoteModel } from '../../agent-core';

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
  QUOTE_TABLE: 'quote-agent-local',
  PUBLIC_ORIGIN: 'https://ridgeline.example',
  QUOTE_SINK_URL: `http://127.0.0.1:${SINK_PORT}/api/quote`,
});
delete process.env.QUOTE_SECRETS_PREFIX;

/** Test-only: a model that asks once, then has everything. Never a real key. */
const scripted: QuoteModel = {
  async decide({ messages }): Promise<QuoteDecision> {
    const said = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (!/pat@example\.com/.test(said)) return { action: 'ask', question: 'What name and email should the request be under?' };
    return {
      action: 'ready',
      values: { full_name: 'Pat Doe', email: 'pat@example.com', service: 'Gutters', timeline: 'this-month', project_description: 'Replace the gutters on a two-story house.' },
    };
  },
};

const { handler, progressStore, useQuoteAgent } = await import('./handler');
useQuoteAgent({ model: scripted, secrets: { relayToken: TOKEN, webhookSigningSecret: 'local-signing-secret', anthropicApiKey: undefined } });

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
        : [{ data: { handoff: 'envelope', reason: 'quote', summary: 'Wants a quote for new gutters.', page: { url: 'https://ridgeline.example/', title: 'Ridgeline Roofing' } }, mediaType: 'application/json', metadata: { extension: 'https://nxis.ai/a2a/handoff/v1' } }],
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
  const res = await handler(event('POST', '/a2a/quote', rpc(text, taskId, contextId), relay));
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
    const reference = `QR-LOCAL${String(posts.length).padStart(3, '0')}`;
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
      TableName: 'quote-agent-local',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
} catch (err) {
  if (!(err instanceof ResourceInUseException)) throw err;
}

try {
  for (const path of ['/a2a/quote/agent-card.json', '/.well-known/agent-card.json']) {
    const r = await handler(event('GET', path));
    const card = typeof r === 'string' ? null : JSON.parse(r.body ?? '{}');
    check(`GET ${path}`, typeof r !== 'string' && r.statusCode === 200 && card?.supportedInterfaces?.[0]?.url === 'https://ridgeline.example/a2a/quote', card?.supportedInterfaces?.[0]?.url);
  }

  for (const [name, headers] of [
    ['no Authorization', {}],
    ['wrong token', { authorization: 'Bearer nope' }],
  ] as const) {
    const r = await handler(event('POST', '/a2a/quote', rpc('hi'), headers));
    check(`POST /a2a/quote, ${name} → 403`, typeof r !== 'string' && r.statusCode === 403, String(typeof r !== 'string' && r.statusCode));
  }
  const big = await handler(event('POST', '/a2a/quote', 'x'.repeat(70_000), relay));
  check('POST /a2a/quote, 70 KB body → 413', typeof big !== 'string' && big.statusCode === 413);

  // A conversation to exactly one submission.
  const t1 = await send(null);
  check('envelope → input required, a question', t1.status === 200 && t1.type.includes('text/event-stream') && t1.state === 'TASK_STATE_INPUT_REQUIRED', `${t1.state}: ${t1.text}`);
  const t2 = await send('Pat Doe, pat@example.com', t1.taskId, t1.contextId);
  check('details → the summary', t2.state === 'TASK_STATE_INPUT_REQUIRED' && t2.text.startsWith("Here's the quote request for Ridgeline Roofing"), t2.text.split('\n')[0]);
  const t3 = await send('yes', t1.taskId, t1.contextId);
  const ref = (t3.handback?.references as { value: string }[] | undefined)?.[0]?.value;
  check('yes → resolved, the sink reference', t3.state === 'TASK_STATE_COMPLETED' && t3.handback?.outcome === 'resolved' && ref === 'QR-LOCAL001', t3.text);
  check('exactly one submission, signed, the form payload', posts.length === 1 && posts[0].signed && posts[0].body.business === 'Ridgeline Roofing' && posts[0].body.email === 'pat@example.com', JSON.stringify(posts[0]?.body));

  // Two concurrent "yes" from two processes → one submission.
  const before = posts.length;
  const u1 = await send(null);
  const u2 = await send('Pat Doe, pat@example.com', u1.taskId, u1.contextId);
  check('second task at its summary', u2.text.startsWith("Here's the quote request"));
  const self = fileURLToPath(import.meta.url);
  const child = () =>
    new Promise<Turn>((ok, fail) => {
      const p = spawn(process.execPath, ['--import', 'tsx', self, 'yes', u1.taskId!, u1.contextId!], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.on('exit', (code) => (code === 0 ? ok(JSON.parse(out)) : fail(new Error(`child exited ${code}`))));
    });
  const [a, b] = await Promise.all([child(), child()]);
  check('two concurrent yes → exactly one submission', posts.length - before === 1, `${posts.length - before} submission(s)`);
  check('both resolved with the reference; one "already sent"', [a, b].every((t) => t.handback?.outcome === 'resolved') && [a, b].every((t) => /Reference QR-LOCAL/.test(t.text)) && [a, b].some((t) => /already been sent/.test(t.text)), `${a.text} | ${b.text}`);

  // The claim itself, 20 at once.
  const id = crypto.randomUUID();
  const wins = await Promise.all(Array.from({ length: 20 }, () => progressStore.claim(id)));
  check('20 concurrent claims on one task → exactly one true', wins.filter(Boolean).length === 1, `${wins.filter(Boolean).length} true`);
  check('after a claim, progress reads as submitted', (await progressStore.get(id))?.submitted === true);
} finally {
  sink.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
