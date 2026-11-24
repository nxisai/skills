/**
 * quote-agent.test.ts — the quote handoff end to end, in one process (vitest).
 *
 * The harness's own HandoffController talks to the relay (handoff-core.ts,
 * from the agent-handoff skill), the relay to the Quote Agent in-process, and
 * the agent submits to a sink this test watches. The model is a script, so
 * each test says what the model decides and checks what the rules around it
 * do with that. Then the page side: with `takes`, the harness keeps the quote
 * form from the model while the agent is available, and gives it back when not.
 *
 * Adapted from the listings example's test/quote-handoff.test.ts. Fix the
 * imports to where the project put each file, and replace the EXAMPLE values
 * (businesses, field values, phone) with the site's. Add a test that the
 * page's real form and the field spec agree (names, required, options), the
 * way the listings test reads its generated pages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCard } from '@a2a-js/sdk';
import {
  AgentHarness,
  HandoffController,
  TRANSFER_TO_AGENT_TOOL,
  buildEnvelope,
  buildHandoffTools,
  formTakenBy,
  type CompletionRequest,
  type HandoffEvent,
  type ModelContextTool,
  type ModelContextToolInfo,
} from '@nxisai/agent-harness';
import { handleHandoff, type RelayOptions, type RelayStore, type RelayTarget } from './handoff-core';
import { RELAY_TOKEN, quoteA2A, quoteAvailability, useQuoteAgent } from './hosts/vite';
import { QuoteExecutor, afterCompleted, extensionPart, isYes, memoryProgress, missing, type Message, type QuoteDecision, type QuoteModel } from './agent-core';
import { exampleSite, match, quoteFields, quotePayload, webhookSink, type Business } from './example-site';
import { PAGE_HANDOFF, QUOTE_PROMPT_LINES } from './page-config';

const ORIGIN = 'http://localhost:5173';
const SECRET = 'test-signing-secret';
const HOME = { url: `${ORIGIN}/`, title: 'Ridgeline Roofing' };

// ── The sink, watched ───────────────────────────────────────────────────────

interface Post {
  body: Record<string, string>;
  signature: string | null;
}
let posts: Post[] = [];
let failSink = false;

const sinkFetch = (async (_url: unknown, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  posts.push({ body: JSON.parse(String(init?.body)), signature: headers.get('x-nxis-signature') });
  if (failSink) return new Response('{}', { status: 500 });
  return Response.json({ status: 'confirmed', reference: `QR-TEST${posts.length}`, confirmedAt: new Date().toISOString() });
}) as typeof fetch;

const site = (businesses?: Business[]) => exampleSite({ businesses, sink: webhookSink({ url: () => 'http://sink.test/webhook', secret: SECRET, fetch: sinkFetch }) });

// ── The relay, and the page's side of it ───────────────────────────────────

function memoryStore(): RelayStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (map.get(k) as T) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

/** The relay's quote target, as the agent-handoff adapter lists it. */
const QUOTE_RELAY_TARGET: RelayTarget = {
  name: 'quote',
  kind: 'agent',
  label: 'Ridgeline Quotes',
  description: 'an agent that takes a quote or estimate request in conversation, confirms it with the visitor, sends it, and returns a quote reference',
  endpoint: '/a2a/quote',
  credential: () => ({ Authorization: `Bearer ${RELAY_TOKEN}` }),
  transcript: false,
  push: false,
  availability: quoteAvailability,
};

/** The relay's fetch: the agent is in this process. */
const relayFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return url.pathname === '/a2a/quote' ? quoteA2A(new Request(url, init)) : fetch(input, init);
};

let relay: RelayOptions;

async function siteFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input), ORIGIN);
  if (!url.pathname.startsWith('/api/handoff')) throw new Error(`No route for ${url.href}`);
  const headers = new Headers(init?.headers);
  // A browser sends its origin on every POST; the page is on this site.
  if (!headers.has('origin')) headers.set('origin', ORIGIN);
  return handleHandoff(new Request(url, { ...init, headers }), url.pathname.replace(/^\/api\/handoff\/?/, ''), relay);
}

/** A model that answers from a script, and remembers what it was shown. */
function scripted(script: QuoteDecision[]) {
  const seen: { system: string; messages: { role: string; content: string }[] }[] = [];
  const model: QuoteModel = {
    async decide(input) {
      seen.push(input);
      const next = script.shift();
      if (!next) throw new Error('The model was asked more often than the script allows.');
      return next;
    },
  };
  return { model, seen };
}

function controllerFor() {
  const controller = new HandoffController({
    relay: `${ORIGIN}/api/handoff`,
    targets: PAGE_HANDOFF.targets,
    fetchImpl: siteFetch as typeof fetch,
    storage: null,
    resumeDelayMs: 50,
  });
  const events: HandoffEvent[] = [];
  controller.addEventListener('handoff', (e) => events.push((e as CustomEvent<HandoffEvent>).detail));
  const texts = () => events.filter((e) => e.type === 'message').map((e) => (e as { text: string }).text);
  const until = async (what: string, pred: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Said: ${JSON.stringify(texts())}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** The agent's next message after `n` so far. */
  const reply = async (n: number) => {
    await until(`message ${n + 1}`, () => texts().length > n);
    return texts()[n];
  };
  return { controller, until, reply };
}

const envelope = (page: { url: string; title: string }, reason: string, summary: string) =>
  buildEnvelope({ target: 'quote', reason, summary, conversationId: 'conv-1', page, origin: ORIGIN, locale: 'en-US' });

beforeEach(() => {
  posts = [];
  failSink = false;
  relay = { targets: [QUOTE_RELAY_TARGET], store: memoryStore(), allowedOrigins: [ORIGIN], fetch: relayFetch };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  useQuoteAgent({ model: null });
});

// EXAMPLE values, valid against the example field spec.
const pat = {
  full_name: 'Pat Kowalski',
  email: 'pat@example.com',
  service: 'Gutters',
  timeline: 'this-month',
  project_description: 'Replace the gutters on the north side of the house.',
};

// ── The handoff ─────────────────────────────────────────────────────────────

describe('hand off to the Quote Agent', () => {
  it('knows the provider, re-asks a bad email, confirms, sends once, and hands back the reference', async () => {
    const { model, seen } = scripted([
      { action: 'ready', values: { ...pat, email: 'pat@example' } },
      { action: 'ready', values: pat },
      { action: 'ready', values: { ...pat, timeline: 'this-week' } },
    ]);
    useQuoteAgent({ model, site: site() });
    const { controller, reply, until } = controllerFor();

    await controller.start('conv-1', 'quote', envelope(HOME, 'Wants a quote for new gutters', 'Visitor wants a quote to replace their gutters.'));
    // The provider came from the page; the model read the envelope.
    expect(seen[0].system).toContain('This request is for Ridgeline Roofing.');
    expect(seen[0].messages[0].content).toContain('Wants a quote for new gutters');
    // The email the model offered fails the rules, so the agent asks again.
    expect(await reply(0)).toMatch(/email address doesn't look right/);

    await controller.send('conv-1', 'pat@example.com');
    const first = await reply(1);
    for (const shown of ['Ridgeline Roofing', 'Pat Kowalski', 'pat@example.com', 'Gutters', 'This month', pat.project_description]) expect(first).toContain(shown);
    expect(first).toMatch(/Shall I send it\?/);
    expect(posts).toHaveLength(0);

    // A change is not a yes: a fresh summary, still nothing sent.
    await controller.send('conv-1', 'Actually, make it this week.');
    expect(await reply(2)).toContain('This week');
    expect(posts).toHaveLength(0);

    await controller.send('conv-1', 'Yes, send it please');
    await until('the hand-back', () => controller.session('conv-1')?.state === 'handed-back');

    // Sent once, signed, exactly as the page's form would post it.
    expect(posts).toHaveLength(1);
    expect(posts[0].signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(posts[0].body).toEqual({ business: 'Ridgeline Roofing', ...pat, phone: '', timeline: 'this-week' });
    expect(Object.keys(posts[0].body)).toEqual(['business', 'full_name', 'email', 'phone', 'service', 'timeline', 'project_description']);

    // The reference is the sink's, word for word.
    const back = controller.session('conv-1')!.handBack!;
    expect(back.outcome).toBe('resolved');
    expect(back.references).toEqual([{ label: 'Quote reference', value: 'QR-TEST1' }]);
    expect(await reply(3)).toBe("Sent to Ridgeline Roofing. Reference QR-TEST1. They'll follow up at pat@example.com.");
    // The yes was read by the rules, not the model.
    expect(seen).toHaveLength(3);
    controller.dispose();
  }, 30_000);

  it('in a directory: asks which provider, in text, and matches the answer', async () => {
    const b = (id: string, name: string, page: string): Business => ({ id, name, page, phone: '(303) 555-0100', is: 'a roofer' });
    const directory = [b('summit-roofing', 'Summit Roofing', '/listings/summit-roofing.html'), b('summit-gutters', 'Summit Gutters Co.', '/listings/summit-gutters.html'), b('alpine', 'Alpine Roof Works', '/listings/alpine.html')];
    const { model, seen } = scripted([{ action: 'ask', question: "What's your name?" }]);
    useQuoteAgent({ model, site: site(directory) });
    const { controller, reply } = controllerFor();

    await controller.start('conv-1', 'quote', envelope({ url: `${ORIGIN}/`, title: 'Directory' }, 'Wants an estimate', 'Visitor needs an estimate for a roof leak repair.'));
    expect(await reply(0)).toBe('Which contractor would you like a quote from? Tell me their name.');

    await controller.send('conv-1', 'Summit');
    const which = await reply(1);
    expect(which).toContain('Summit Roofing');
    expect(which).toContain('Summit Gutters Co.');

    await controller.send('conv-1', 'Summit Roofing');
    expect(await reply(2)).toBe("What's your name?");
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toContain('This request is for Summit Roofing.');
    controller.dispose();
  }, 30_000);

  it('asks for a required value the model left out instead of sending', async () => {
    const { full_name: _, ...rest } = pat;
    useQuoteAgent({ model: scripted([{ action: 'ready', values: rest }]).model, site: site() });
    const { controller, reply } = controllerFor();
    await controller.start('conv-1', 'quote', envelope(HOME, 'Quote', 'Wants a gutter quote.'));
    expect(await reply(0)).toBe('What name should the request be under?');
    expect(posts).toHaveLength(0);
    controller.dispose();
  }, 30_000);

  it('hands an emergency back with the phone number, sending nothing and asking the model nothing', async () => {
    const { model, seen } = scripted([]);
    useQuoteAgent({ model, site: site() });
    const { controller, until, reply } = controllerFor();
    await controller.start('conv-1', 'quote', envelope(HOME, 'Water is pouring in through the ceiling after the storm', 'Water is pouring in through the ceiling after the storm; wants a quote.'));
    await until('the hand-back', () => controller.session('conv-1')?.state === 'handed-back');
    expect(await reply(0)).toContain('(303) 555-0142');
    expect(controller.session('conv-1')!.handBack).toEqual(expect.objectContaining({ outcome: 'unresolved', references: [] }));
    expect(posts).toHaveLength(0);
    expect(seen).toHaveLength(0);
    controller.dispose();
  }, 30_000);

  it('says the form still works when sending fails, with no reference, and never retries', async () => {
    failSink = true;
    useQuoteAgent({ model: scripted([{ action: 'ready', values: pat }]).model, site: site() });
    const { controller, until, reply } = controllerFor();
    await controller.start('conv-1', 'quote', envelope(HOME, 'Quote', 'Wants a gutter quote.'));
    await reply(0);
    await controller.send('conv-1', 'yes');
    await until('the hand-back', () => controller.session('conv-1')?.state === 'handed-back');
    expect(await reply(1)).toMatch(/quote form on their page still works/);
    expect(controller.session('conv-1')!.handBack).toEqual(expect.objectContaining({ outcome: 'unresolved', references: [] }));
    expect(posts).toHaveLength(1);
    controller.dispose();
  }, 30_000);

  it('is offered as unavailable without a model', async () => {
    useQuoteAgent({ model: null, site: site() });
    const { controller } = controllerFor();
    const targets = await controller.targets();
    expect(targets.find((t) => t.name === 'quote')).toEqual(expect.objectContaining({ kind: 'agent', available: false }));
    await expect(controller.start('conv-1', 'quote', envelope(HOME, 'Quote', 'Wants a quote.'))).rejects.toThrow(/away/);
    controller.dispose();
  });
});

// ── The page: quote takes the quote form ────────────────────────────────────

describe('a second yes on the same task', () => {
  // Two "yes" can reach one task at once: a double tap, a relay retry, two instances. The claim
  // lets one send; this is about what the other one says.
  const user = (n: number, text: string, extra: Message['parts'] = []): Message => ({ messageId: `u${n}`, role: 'ROLE_USER', parts: [{ text }, ...extra] });
  const opening = user(0, 'I want a quote', [extensionPart({ handoff: 'envelope', ...envelope(HOME, 'Quote', 'Wants a gutter quote.') })]);

  /** The second "yes" starts `lag` ms after the first: 0 reads before the claim, 100 after it. */
  async function twoYeses(sink: () => Promise<Response>, lag = 0) {
    const slow = (async (_url: unknown, init?: RequestInit) => {
      posts.push({ body: JSON.parse(String(init?.body)), signature: new Headers(init?.headers).get('x-nxis-signature') });
      await new Promise((r) => setTimeout(r, 300));
      return sink();
    }) as typeof fetch;
    const s = exampleSite({ sink: webhookSink({ url: () => 'http://sink.test/webhook', secret: SECRET, fetch: slow }) });
    const executor = new QuoteExecutor(s, () => scripted([{ action: 'ready', values: pat }]).model, memoryProgress());
    const first = await executor.turn('task-1', [opening]);
    expect(first.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const history = [opening, { messageId: 'a1', role: 'ROLE_AGENT', parts: first.message.parts } as Message, user(1, 'yes')];
    const later = () => (lag ? new Promise((r) => setTimeout(r, lag)).then(() => executor.turn('task-1', history)) : executor.turn('task-1', history));
    return Promise.all([executor.turn('task-1', history), later()]);
  }

  const handBackOf = (t: { message: Message }) => t.message.parts.map((p) => p.data as Record<string, unknown> | undefined).find((d) => d?.handoff === 'handback');

  it('sends once, and both replies carry the reference', async () => {
    const [a, b] = await twoYeses(async () => Response.json({ status: 'confirmed', reference: 'QR-TWICE01' }));
    expect(posts).toHaveLength(1);
    for (const t of [a, b]) {
      expect(handBackOf(t)).toEqual(expect.objectContaining({ outcome: 'resolved', references: [{ label: 'Quote reference', value: 'QR-TWICE01' }] }));
    }
    expect([a, b].map((t) => t.message.parts[0].text).join(' ')).toMatch(/already been sent\. Reference QR-TWICE01/);
  }, 30_000);

  it('a yes that reads the task after the claim, before the sink answers, still carries the reference', async () => {
    // Seen on Lambda (LocalStack): the second invocation read progress once the first had claimed.
    const [a, b] = await twoYeses(async () => Response.json({ status: 'confirmed', reference: 'QR-LATE01' }), 100);
    expect(posts).toHaveLength(1);
    expect(b.message.parts[0].text).toMatch(/already been sent\. Reference QR-LATE01/);
    for (const t of [a, b]) expect(handBackOf(t)).toEqual(expect.objectContaining({ outcome: 'resolved', references: [{ label: 'Quote reference', value: 'QR-LATE01' }] }));
  }, 30_000);

  it('a completed task keeps how its send ended, and nothing the visitor said', () => {
    // Deleting it on completion would race a "yes" still waiting for the reference.
    const pending = { full_name: 'Pat Kowalski', email: 'pat@example.com' };
    expect(afterCompleted({ submitted: true, reference: 'QR-1', pending })).toEqual({ submitted: true, reference: 'QR-1' });
    expect(afterCompleted({ submitted: true, sendFailed: true })).toEqual({ submitted: true, sendFailed: true });
    expect(afterCompleted({ pending })).toBeNull();
    expect(afterCompleted(null)).toBeNull();
  });

  it("never says a failed send went through", async () => {
    const [a, b] = await twoYeses(async () => new Response('{}', { status: 500 }));
    expect(posts).toHaveLength(1);
    for (const t of [a, b]) {
      expect(handBackOf(t)).toEqual(expect.objectContaining({ outcome: 'unresolved', references: [] }));
      expect(t.message.parts[0].text).not.toMatch(/already been sent/);
    }
  }, 30_000);
});

describe('the page makes quote the target for a quote request', () => {
  it('declares takes, and the prompt names no form tool', () => {
    expect(PAGE_HANDOFF.targets.quote.takes).toEqual(['quote_form']);
    expect(QUOTE_PROMPT_LINES.join(' ')).toContain('call transfer_to_agent with target quote');
    // A tool the prompt names gets called, even on a turn it was hidden from.
    expect(QUOTE_PROMPT_LINES.join(' ')).not.toMatch(/quote_form/);
  });

  /** The on-page harness: the page's quote form, the site-wide one, a read, and the handoff tools. The model calls the form anyway. */
  async function onPage() {
    const { controller } = controllerFor();
    const handoffTools = await buildHandoffTools(controller, { conversationId: () => 'conv-1' });
    const form = (name: string) =>
      ({ name, description: 'Request a quote', inputSchema: { type: 'object', properties: { business: { type: 'string' }, project_description: { type: 'string' } } } }) as unknown as ModelContextToolInfo;
    const tools = [form('quote_form'), form('quote_form_anywhere'), { name: 'nxis_query', annotations: { readOnlyHint: true } }, ...handoffTools] as ModelContextToolInfo[];
    const offered: string[] = [];
    const confirmed: { tool: string; values: Record<string, unknown> }[] = [];
    const asked: string[] = [];
    const harness = new AgentHarness({
      provider: {
        name: 'script',
        label: 'Script',
        local: false,
        ready: true,
        loading: false,
        complete: async (req: CompletionRequest) => {
          offered.push(...req.tools.map((t) => t.name));
          return { text: '', call: { name: 'quote_form_anywhere', args: { business: 'Ridgeline Roofing', project_description: 'New gutters' } } };
        },
      },
      toolSource: { discoverTools: async () => tools, execTool: async () => ({ content: [] }), modelContext: () => null } as never,
      renderer: {
        streaming: () => ({ thinking() {}, update() {}, finalize() {} }),
        message() {},
        status() {},
        ask: (req: { tool: ModelContextTool }) => void asked.push(req.tool.name),
        confirm: (req: { tool: ModelContextTool; values: Record<string, unknown> }) => void confirmed.push({ tool: req.tool.name, values: req.values }),
      } as never,
      handoff: () => controller,
    });
    return { controller, harness, offered, confirmed, asked };
  }

  it('hides the quote form tools while quote is available, and makes a call to them the handoff', async () => {
    useQuoteAgent({ model: scripted([]).model, site: site() });
    const { controller, harness, offered, confirmed, asked } = await onPage();
    expect((await formTakenBy(controller, 'quote_form'))?.name).toBe('quote');
    expect((await formTakenBy(controller, 'quote_form_anywhere'))?.name).toBe('quote');

    await harness.turn('Get a quote from Ridgeline Roofing', []);
    expect(offered).toContain(TRANSFER_TO_AGENT_TOOL);
    expect(offered).not.toContain('quote_form');
    expect(offered).not.toContain('quote_form_anywhere');
    // The model called the form anyway: the visitor is asked to Send the handoff, built from that call.
    expect(asked).toEqual([]);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].tool).toBe(TRANSFER_TO_AGENT_TOOL);
    expect(confirmed[0].values).toEqual(expect.objectContaining({ target: 'quote' }));
    controller.dispose();
  });

  it('offers the quote form tools, and runs the form, when quote is away', async () => {
    useQuoteAgent({ model: null, site: site() });
    const { controller, harness, offered, confirmed } = await onPage();
    expect(await formTakenBy(controller, 'quote_form')).toBeNull();
    await harness.turn('Get a quote from Ridgeline Roofing', []);
    expect(offered).toEqual(expect.arrayContaining(['quote_form', 'quote_form_anywhere']));
    expect(confirmed).toEqual([{ tool: 'quote_form_anywhere', values: { business: 'Ridgeline Roofing', project_description: 'New gutters' } }]);
    controller.dispose();
  });
});

// ── The endpoint and card ───────────────────────────────────────────────────

describe('the endpoint', () => {
  it('only lets the relay in', async () => {
    expect((await quoteA2A(new Request(`${ORIGIN}/a2a/quote`, { method: 'POST', body: '{}' }))).status).toBe(403);
    const wrong = await quoteA2A(new Request(`${ORIGIN}/a2a/quote`, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer guessed' } }));
    expect(wrong.status).toBe(403);
  });

  it('serves its card, pointing at the origin it was asked on', async () => {
    const card = (await (await quoteA2A(new Request('https://tunnel.example/a2a/quote/agent-card.json'))).json()) as Record<string, any>;
    expect(card.supportedInterfaces).toEqual([{ url: 'https://tunnel.example/a2a/quote', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    const parsed = AgentCard.fromJSON(card);
    expect(parsed.securitySchemes.relay.scheme).toEqual({ $case: 'httpAuthSecurityScheme', value: expect.objectContaining({ scheme: 'Bearer' }) });
  });
});

// ── Rules ───────────────────────────────────────────────────────────────────

describe('rules', () => {
  const ridgeline = { id: 'ridgeline-roofing', name: 'Ridgeline Roofing', phone: '', page: '/', is: '', services: [{ name: 'Gutters' }] } as Business;
  const fields = quoteFields(ridgeline);

  it('checks required fields, email shape, phone digits and choices', () => {
    expect(missing(fields, pat)).toBeNull();
    expect(missing(fields, { ...pat, email: 'pat@' })).toMatch(/email/);
    expect(missing(fields, { ...pat, phone: '555-01' })).toMatch(/phone number/);
    expect(missing(fields, { ...pat, phone: '(303) 555-0100' })).toBeNull();
    expect(missing(fields, { ...pat, timeline: 'next-year' })).toMatch(/timeline/);
    expect(missing(fields, { ...pat, service: 'Plumbing' })).toMatch(/service/);
    expect(missing(fields, { ...pat, project_description: ' ' })).toMatch(/about the job/);
  });

  it('takes only a plain yes as a yes', () => {
    for (const yes of ['yes', 'Yes!', 'yep, send it', 'ok go ahead', 'Looks good, thanks', 'confirm']) expect(isYes(yes), yes).toBe(true);
    for (const no of ['no', 'yes but change the email', 'not yet', 'what will it cost?', '']) expect(isYes(no), no).toBe(false);
  });

  it('a one-business site never asks which business', () => {
    expect(match('Ridgeline please')).toEqual([]);
  });

  it('posts what the form posts: an empty phone sent empty, an unchosen select left out', () => {
    const { service: _s, timeline: _t, ...bare } = pat;
    expect(quotePayload(ridgeline, bare)).toEqual({ business: 'Ridgeline Roofing', full_name: pat.full_name, email: pat.email, phone: '', project_description: pat.project_description });
  });
});
