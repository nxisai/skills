// hosts/lambda/localstack/drive.mjs — TEST ONLY: drives a Function URL over HTTP, as the relay would.
//
//   RELAY_TOKEN=<the test token> SINK=http://127.0.0.1:4577 node drive.mjs <function URL> [<second URL>]
//
// With a second URL (another replica or instance of the same agent), every "yes" goes there: the
// summary is shown by one and confirmed on the other, and the two concurrent yeses go one to each.
//
// Checks: both cards point at PUBLIC_ORIGIN (https://northside.example); no or a wrong token → 403;
// a 70 KB body → 413; envelope → the calendar's offer → a pick → details → summary → yes → completed
// with the sink's reference, one signed booking; then two "yes" at once on a second task → one
// booking, and the losing reply also carries the reference. Prints the two task ids for the table check.
const base = process.argv[2]?.replace(/\/+$/, '');
const other = process.argv[3]?.replace(/\/+$/, '') ?? base;
const TOKEN = process.env.RELAY_TOKEN;
const SINK = process.env.SINK ?? 'http://127.0.0.1:4577';
/** The origin the card must point at: PUBLIC_ORIGIN, or (a Worker builds it per request) the URL driven. */
const CARD_ORIGIN = process.env.CARD_ORIGIN ?? 'https://northside.example';
if (!base || !TOKEN) throw new Error('usage: RELAY_TOKEN=… node drive.mjs <function URL>');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const relay = { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'content-type': 'application/json', 'a2a-version': '1.0', 'a2a-extensions': 'https://nxis.ai/a2a/handoff/v1' };
const envelope = { data: { handoff: 'envelope', reason: 'booking', summary: 'Kitchen drain is slow; wants someone to come and clear it.', page: { url: 'https://northside.example/', title: 'Northside Plumbing' } }, mediaType: 'application/json', metadata: { extension: 'https://nxis.ai/a2a/handoff/v1' } };
const rpc = (text, taskId, contextId) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'SendStreamingMessage',
  params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', ...(taskId ? { taskId, contextId } : {}), parts: text ? [{ text }] : [envelope] }, configuration: { acceptedOutputModes: ['text/plain', 'application/json'] } },
});

/** One turn: the buffered SSE body, read for the task, its last state and what the agent said. */
async function send(text, taskId, contextId, at = base) {
  const res = await fetch(`${at}/a2a/booking`, { method: 'POST', headers: relay, body: JSON.stringify(rpc(text, taskId, contextId)) });
  const turn = { status: res.status, type: res.headers.get('content-type') ?? '', text: '' };
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6));
    if (event.error) turn.error = event.error.message;
    const r = event.result ?? {};
    const t = r.task ?? r.statusUpdate;
    if (!t) continue;
    turn.taskId ??= t.id ?? t.taskId;
    turn.contextId ??= t.contextId;
    turn.state = t.status?.state;
    const parts = t.status?.message?.parts ?? [];
    if (parts.length) {
      turn.text = parts.map((p) => p.text ?? '').join('');
      turn.handback = parts.find((p) => p.data?.handoff === 'handback')?.data;
    }
  }
  return turn;
}
const posts = async () => (await fetch(`${SINK}/posts`)).json();
const ref = (n) => `NB-TEST${String(n).padStart(4, '0')}`;
const DETAILS = 'Pat Doe, 773-555-0100, pat@example.com, 5100 N Milwaukee Ave 60630';

for (const path of ['/a2a/booking/agent-card.json', '/.well-known/agent-card.json']) {
  const r = await fetch(`${base}${path}`);
  const url = (await r.json().catch(() => null))?.supportedInterfaces?.[0]?.url;
  check(`GET ${path} → the card at ${CARD_ORIGIN}`, r.status === 200 && url === `${CARD_ORIGIN}/a2a/booking`, url);
}
for (const [name, h] of [['no token', {}], ['wrong token', { authorization: 'Bearer test-wrong-token' }]]) {
  const r = await fetch(`${base}/a2a/booking`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(rpc('hi')) });
  check(`POST, ${name} → 403`, r.status === 403, String(r.status));
}
{
  const r = await fetch(`${base}/a2a/booking`, { method: 'POST', headers: relay, body: 'x'.repeat(70_000) });
  check('POST, 70 KB body → 413', r.status === 413, String(r.status));
}

// One conversation to one submission.
const sent0 = (await posts()).length;
const t1 = await send(null);
check("envelope → the calendar's offer", t1.status === 200 && t1.type.includes('text/event-stream') && t1.state === 'TASK_STATE_INPUT_REQUIRED' && /\n1\. /.test(t1.text), `${t1.state}: ${t1.text}`);
const t1b = await send('1', t1.taskId, t1.contextId);
check('a pick → the first detail asked for', t1b.text === 'What name should the booking be under?', t1b.text);
const t2 = await send(DETAILS, t1.taskId, t1.contextId);
check('details → the summary', t2.state === 'TASK_STATE_INPUT_REQUIRED' && t2.text.startsWith("Here's the booking with Northside Plumbing"), t2.text.split('\n')[0]);
const t3 = await send('yes', t1.taskId, t1.contextId, other);
const p1 = await posts();
check('yes → completed, resolved, the sink reference', t3.state === 'TASK_STATE_COMPLETED' && t3.handback?.outcome === 'resolved' && t3.handback?.references?.[0]?.value === ref(p1.length), t3.text);
check('one booking, signed, the form payload', p1.length - sent0 === 1 && p1.at(-1).signed && p1.at(-1).body.service === 'drain-cleaning' && p1.at(-1).body.email === 'pat@example.com', JSON.stringify(p1.at(-1)?.body));

// Two "yes" at once on a second task.
const u1 = await send(null);
await send('1', u1.taskId, u1.contextId);
const u2 = await send(DETAILS, u1.taskId, u1.contextId);
check('second task at its summary', u2.text.startsWith("Here's the booking"));
const sent1 = (await posts()).length;
const [a, b] = await Promise.all([send('yes', u1.taskId, u1.contextId), send('yes', u1.taskId, u1.contextId, other)]);
const p2 = await posts();
check('two concurrent yes → one booking', p2.length - sent1 === 1, `${p2.length - sent1} booking(s)`);
const r2 = ref(p2.length);
// On separate instances (Lambda, two replicas) both turns run, and the loser says "already made" with
// the reference. On one process the A2A SDK refuses a second message to a task that is still running
// (a stream error, no turn): nothing booked twice, and the relay keeps the reply that carries it.
const won = [a, b].filter((t) => t.state === 'TASK_STATE_COMPLETED' && t.handback?.outcome === 'resolved' && t.text.includes(r2));
const lost = [a, b].find((t) => !won.includes(t));
check(
  'one booked with the reference; the other "already made" with it, or refused by the SDK on one process',
  won.length === 2 ? [a, b].some((t) => t.text.startsWith('Your booking has already been made. Reference')) : won.length === 1 && !!lost?.error && !lost.text,
  `${a.text || a.error} | ${b.text || b.error}`,
);
console.log(JSON.stringify({ completedTask: t1.taskId, concurrentTask: u1.taskId }));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
