// hosts/lambda/localstack/stubs.mjs — TEST ONLY, for the LocalStack run in ../../lambda.md.
//
//   node stubs.mjs sink    the site on :4129. GET /api/slots: free slots, two a day at 14:00Z and
//                          16:00Z (8:00 and 10:00 in Chicago in winter); POST /api/book: checks
//                          X-Nxis-Signature with the test secret, refuses a taken slot with 409,
//                          waits SINK_DELAY_MS, answers NB-TEST0001, NB-TEST0002, …;
//                          GET /posts lists what it received
//   node stubs.mjs model   Anthropic's Messages API on :4130, reached through the SDK's
//                          ANTHROPIC_BASE_URL: calls `details` with a service and a day two days
//                          out, then with the contact details once they are given.
//                          Never a real key; it records only whether the test key arrived
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const SIGNING_SECRET = 'test-signing-secret';
const MODEL_KEY = 'test-model-key-not-real';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const read = async (req) => { let s = ''; for await (const c of req) s += c; return s; };

if (process.argv[2] === 'sink') {
  const posts = [];
  const taken = new Set();
  const delay = Number(process.env.SINK_DELAY_MS ?? 1500);
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (req.method === 'GET' && url.pathname === '/posts') return json(res, 200, posts);
    if (req.method === 'GET' && url.pathname === '/api/slots') {
      const from = Date.parse(url.searchParams.get('from'));
      const to = Date.parse(url.searchParams.get('to'));
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const slots = [];
      for (let day = Date.parse(new Date(from).toISOString().slice(0, 10)); day < to && slots.length < limit; day += 86_400_000) {
        for (const h of [14, 16]) {
          const start = day + h * 3_600_000;
          const id = new Date(start).toISOString();
          if (start >= from && start < to && !taken.has(id) && slots.length < limit) slots.push({ id, start: id, end: new Date(start + 7_200_000).toISOString() });
        }
      }
      return json(res, 200, { slots });
    }
    if (req.method !== 'POST' || url.pathname !== '/api/book') return json(res, 404, {});
    const body = await read(req);
    const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(req.headers['x-nxis-signature'] ?? '');
    const signed = !!m && createHmac('sha256', SIGNING_SECRET).update(`${m[1]}.`).update(body).digest('hex') === m[2];
    const booking = JSON.parse(body);
    posts.push({ body: booking, signed, key: req.headers['idempotency-key'] ?? null });
    if (taken.has(booking.slot_id)) return json(res, 409, { status: 'conflict' });
    taken.add(booking.slot_id);
    const reference = `NB-TEST${String(posts.length).padStart(4, '0')}`;
    // A slow sink widens the window in which two "yes" overlap.
    await new Promise((r) => setTimeout(r, delay));
    json(res, 200, { status: 'confirmed', reference });
  }).listen(4129, () => console.log('sink stub on :4129'));
} else if (process.argv[2] === 'model') {
  const calls = [];
  createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/calls') return json(res, 200, calls);
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return json(res, 404, {});
    const body = JSON.parse(await read(req));
    // @anthropic-ai/sdk 1.x sends the key as a bearer; earlier versions as x-api-key.
    const keyOk = req.headers.authorization === `Bearer ${MODEL_KEY}` || req.headers['x-api-key'] === MODEL_KEY;
    calls.push({ keyOk, model: body.model });
    if (!keyOk) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'not the test key' } });
    const text = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((b) => b.text ?? '').join(' '));
    const said = (body.messages ?? []).filter((m) => m.role === 'user').map(text).join('\n');
    const base = { service: 'drain-cleaning', date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) };
    const use = /pat@example\.com/.test(said)
      ? { name: 'details', input: { values: { ...base, full_name: 'Pat Doe', phone: '773-555-0100', email: 'pat@example.com', street: '5100 N Milwaukee Ave', zip: '60630' } } }
      : { name: 'details', input: { values: base } };
    json(res, 200, { id: `msg_test_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: `toolu_test_${calls.length}`, ...use }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }).listen(4130, () => console.log('model stub on :4130'));
} else {
  console.error('usage: node stubs.mjs sink|model');
  process.exit(2);
}
