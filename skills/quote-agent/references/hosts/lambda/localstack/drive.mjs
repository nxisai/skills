// hosts/lambda/localstack/drive.mjs — TEST ONLY: drives a Function URL over HTTP, as the relay would.
//
//   RELAY_TOKEN=<the test token> SINK=http://127.0.0.1:4577 node drive.mjs <function URL>
//
// Checks: both cards point at PUBLIC_ORIGIN (https://ridgeline.example); no or a wrong token → 403;
// a 70 KB body → 413; envelope → question → summary → yes → completed with the sink's reference,
// one signed submission; then two "yes" at once on a second task → one submission, and the losing
// reply also carries the reference. Prints the two task ids for the table check.
const base = process.argv[2]?.replace(/\/+$/, '');
const TOKEN = process.env.RELAY_TOKEN;
const SINK = process.env.SINK ?? 'http://127.0.0.1:4577';
if (!base || !TOKEN) throw new Error('usage: RELAY_TOKEN=… node drive.mjs <function URL>');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const relay = { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'content-type': 'application/json', 'a2a-version': '1.0', 'a2a-extensions': 'https://nxis.ai/a2a/handoff/v1' };
const envelope = { data: { handoff: 'envelope', reason: 'quote', summary: 'Wants a quote for new gutters.', page: { url: 'https://ridgeline.example/', title: 'Ridgeline Roofing' } }, mediaType: 'application/json', metadata: { extension: 'https://nxis.ai/a2a/handoff/v1' } };
const rpc = (text, taskId, contextId) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'SendStreamingMessage',
  params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', ...(taskId ? { taskId, contextId } : {}), parts: text ? [{ text }] : [envelope] }, configuration: { acceptedOutputModes: ['text/plain', 'application/json'] } },
});

/** One turn: the buffered SSE body, read for the task, its last state and what the agent said. */
async function send(text, taskId, contextId) {
  const res = await fetch(`${base}/a2a/quote`, { method: 'POST', headers: relay, body: JSON.stringify(rpc(text, taskId, contextId)) });
  const turn = { status: res.status, type: res.headers.get('content-type') ?? '', text: '' };
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const r = JSON.parse(line.slice(6)).result ?? {};
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
const ref = (n) => `QR-TEST${String(n).padStart(4, '0')}`;

for (const path of ['/a2a/quote/agent-card.json', '/.well-known/agent-card.json']) {
  const r = await fetch(`${base}${path}`);
  const url = (await r.json().catch(() => null))?.supportedInterfaces?.[0]?.url;
  check(`GET ${path} → the card at PUBLIC_ORIGIN`, r.status === 200 && url === 'https://ridgeline.example/a2a/quote', url);
}
for (const [name, h] of [['no token', {}], ['wrong token', { authorization: 'Bearer test-wrong-token' }]]) {
  const r = await fetch(`${base}/a2a/quote`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(rpc('hi')) });
  check(`POST, ${name} → 403`, r.status === 403, String(r.status));
}
{
  const r = await fetch(`${base}/a2a/quote`, { method: 'POST', headers: relay, body: 'x'.repeat(70_000) });
  check('POST, 70 KB body → 413', r.status === 413, String(r.status));
}

// One conversation to one submission.
const sent0 = (await posts()).length;
const t1 = await send(null);
check('envelope → input required, a question', t1.status === 200 && t1.type.includes('text/event-stream') && t1.state === 'TASK_STATE_INPUT_REQUIRED', `${t1.state}: ${t1.text}`);
const t2 = await send('Pat Doe, pat@example.com', t1.taskId, t1.contextId);
check('details → the summary', t2.state === 'TASK_STATE_INPUT_REQUIRED' && t2.text.startsWith("Here's the quote request for Ridgeline Roofing"), t2.text.split('\n')[0]);
const t3 = await send('yes', t1.taskId, t1.contextId);
const p1 = await posts();
check('yes → completed, resolved, the sink reference', t3.state === 'TASK_STATE_COMPLETED' && t3.handback?.outcome === 'resolved' && t3.handback?.references?.[0]?.value === ref(p1.length), t3.text);
check('one submission, signed, the form payload', p1.length - sent0 === 1 && p1.at(-1).signed && p1.at(-1).body.email === 'pat@example.com', JSON.stringify(p1.at(-1)?.body));

// Two "yes" at once on a second task.
const u1 = await send(null);
const u2 = await send('Pat Doe, pat@example.com', u1.taskId, u1.contextId);
check('second task at its summary', u2.text.startsWith("Here's the quote request"));
const sent1 = (await posts()).length;
const [a, b] = await Promise.all([send('yes', u1.taskId, u1.contextId), send('yes', u1.taskId, u1.contextId)]);
const p2 = await posts();
check('two concurrent yes → one submission', p2.length - sent1 === 1, `${p2.length - sent1} submission(s)`);
const r2 = ref(p2.length);
check(
  'both resolved; the losing reply is "already sent" with the reference',
  [a, b].every((t) => t.state === 'TASK_STATE_COMPLETED' && t.handback?.outcome === 'resolved' && t.text.includes(r2)) && [a, b].some((t) => t.text.startsWith('Your request has already been sent. Reference')),
  `${a.text} | ${b.text}`,
);
console.log(JSON.stringify({ completedTask: t1.taskId, concurrentTask: u1.taskId }));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
