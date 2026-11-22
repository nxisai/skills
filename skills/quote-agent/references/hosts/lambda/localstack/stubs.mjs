// hosts/lambda/localstack/stubs.mjs — TEST ONLY, for the LocalStack run in ../../lambda.md.
//
//   node stubs.mjs sink    the site's quote sink on :4129: checks X-Nxis-Signature with the test
//                          secret, waits SINK_DELAY_MS, answers QR-TEST0001, QR-TEST0002, …;
//                          GET /posts lists what it received
//   node stubs.mjs model   Anthropic's Messages API on :4130, reached through the SDK's
//                          ANTHROPIC_BASE_URL: asks for name and email once, then calls `ready`.
//                          Never a real key; it records only whether the test key arrived
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const SIGNING_SECRET = 'test-signing-secret';
const MODEL_KEY = 'test-model-key-not-real';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const read = async (req) => { let s = ''; for await (const c of req) s += c; return s; };

if (process.argv[2] === 'sink') {
  const posts = [];
  const delay = Number(process.env.SINK_DELAY_MS ?? 1500);
  createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/posts') return json(res, 200, posts);
    if (req.method !== 'POST' || req.url !== '/api/quote') return json(res, 404, {});
    const body = await read(req);
    const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(req.headers['x-nxis-signature'] ?? '');
    const signed = !!m && createHmac('sha256', SIGNING_SECRET).update(`${m[1]}.`).update(body).digest('hex') === m[2];
    posts.push({ body: JSON.parse(body), signed });
    const reference = `QR-TEST${String(posts.length).padStart(4, '0')}`;
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
    const use = /pat@example\.com/.test(said)
      ? { name: 'ready', input: { values: { full_name: 'Pat Doe', email: 'pat@example.com', service: 'Gutters', timeline: 'this-month', project_description: 'Replace the gutters on a two-story house.' } } }
      : { name: 'ask_visitor', input: { question: 'What name and email should the request be under?' } };
    json(res, 200, { id: `msg_test_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: `toolu_test_${calls.length}`, ...use }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  }).listen(4130, () => console.log('model stub on :4130'));
} else {
  console.error('usage: node stubs.mjs sink|model');
  process.exit(2);
}
