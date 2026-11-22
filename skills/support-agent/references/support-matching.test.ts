/**
 * support-matching.test.ts — a visitor's own word forms, and why a turn ended not found (vitest, in process).
 *
 * Over an events site's real FAQ (fixtures/wrenfield-faq.json): one FAQPage record with 25 questions, as its MCP server
 * returns it, and the rows its help query returned for two rewrites. The models are scripted: no model is called.
 *
 * - the word score joins a word's forms (refund, refunded, refundable; cancel, canceled, cancelled, cancellation) and
 *   reads contractions, on the question and the answer together;
 * - an exact phrasing answers; no candidates is the not-found reply, and the first turn after a handoff is greeted;
 * - the grounding check still refuses a non-verbatim FAQ answer;
 * - the logs say which not-found it was: the compose step called not_found, or its answers were refused by the
 *   grounding check, and why, with no word of the visitor's message, the claim or a record.
 *
 * Fix the imports to where the project put each file.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SupportExecutor,
  contentTokens,
  extensionPart,
  passagesOf,
  plainText,
  refusalForLog,
  textOf,
  type ChatMessage,
  type JsonLd,
  type Message,
  type RecordRow,
  type SupportDecision,
  type SupportModel,
  type SupportRecords,
  type SupportSite,
} from './support-core';
import { exampleSite } from './example-site';
import fixture from './fixtures/wrenfield-faq.json';

const FAQ = fixture.faq as unknown as JsonLd;
const FAQ_ID = FAQ['@id']!;
const QUESTIONS = (FAQ.mainEntity as { name: string; acceptedAnswer: { text: string } }[]).map((q, i) => ({ i, name: q.name, answer: plainText(q.acceptedAnswer.text) }));
const q = (name: string) => QUESTIONS.find((x) => x.name === name)!;
const REFUND = q('Can I get a refund?');
const CANCELED = q('What happens if an event is canceled or moved?');
const FEES = q('Are fees and taxes included in the price?');
const HELP_ROWS = fixture.help as unknown as Record<string, RecordRow[]>;
/** The FAQ as an older server returns it: a row with no score and no located passage. */
const PLAIN_ROW: RecordRow = { '@id': FAQ_ID, '@type': 'FAQPage', url: FAQ_ID };

/** The read tools over the FAQ. `rows(query)` is what the help query returns; every other query finds nothing. */
function records(rows: (query: string) => RecordRow[]): SupportRecords {
  return {
    async query(args) {
      if (!args.text || args.filter.schema_type !== 'CreativeWork' || args.retrieval === 'keyword') return [];
      return structuredClone(rows(args.text));
    },
    get: async (id) => (id === FAQ_ID ? structuredClone(FAQ) : null),
    listTypes: async () => ['FAQPage'],
  };
}

/** The passages the compose was shown, read back out of its prompt. */
const shownIn = (messages: ChatMessage[]) => [...messages[messages.length - 1].content.matchAll(/<record id="([^"]*)" path="([^"]*)" type="([^"]*)">/g)].map((m) => m[2]);

type Compose = SupportDecision | ((shown: string[]) => SupportDecision);

/** Scripted models: the rewrite returns `query`; the compose follows its script. */
function model(o: { query: string; compose?: Compose[] }) {
  const seen = { compose: [] as { system: string; messages: ChatMessage[] }[] };
  const composes = [...(o.compose ?? [])];
  const m: SupportModel = {
    rewrite: vi.fn(async () => o.query),
    compose: vi.fn(async (input: { system: string; messages: ChatMessage[] }) => {
      seen.compose.push(structuredClone(input));
      const next = composes.shift();
      if (!next) throw new Error('The compose model was asked more often than the script allows.');
      return typeof next === 'function' ? next(shownIn(input.messages)) : next;
    }),
  };
  return { model: m, seen };
}

const quote = (x: { i: number; answer: string }): SupportDecision => ({ kind: 'answer', claims: [{ text: x.answer, cites: [{ id: FAQ_ID, path: `mainEntity[${x.i}]` }] }] });
const faqReply = (x: { name: string; answer: string }) => `Our FAQ answers this under "${x.name}":\n${x.answer}`;

function agent(rec: SupportRecords, m: SupportModel, over: Partial<SupportSite> = {}) {
  const site: SupportSite = {
    ...exampleSite({ records: rec, gaps: null, gapReports: false, turns: null }),
    agentName: 'Wrenfield Help',
    siteName: 'Wrenfield Events',
    allowedLinkOrigins: ['https://wrenfield.example'],
    productNames: async () => [],
    ...over,
  };
  return new SupportExecutor(site, () => m);
}

const envelope = () => extensionPart({ handoff: 'envelope', reason: 'A support question', summary: 'The visitor would like to talk to support.', locale: 'en-US', ui: { cards: 1 }, page: { url: 'https://wrenfield.example/faq' } });
const user = (text: string, withEnvelope = false): Message => ({ messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }, ...(withEnvelope ? [envelope()] : [])] });
const agentSaid = (text: string): Message => ({ messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text }] });

/** The visitor's question on the turn after the handoff's greeting. */
const ask = (exec: SupportExecutor, text: string) =>
  exec.turn(crypto.randomUUID(), [user('The visitor would like to talk to support.', true), agentSaid("Hi, I'm Wrenfield Help. What can I help you with?"), user(text)]);

/** The support log lines a turn wrote, at info and error. */
function logs() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return {
    lines: () => [...info.mock.calls, ...error.mock.calls].map((c) => c.map(String).join(' ')).filter((l) => l.startsWith('[support]')),
    restore: () => (info.mockRestore(), error.mockRestore()),
  };
}

describe('the word score', () => {
  it("joins a word's forms, so the visitor's and the FAQ's words meet", () => {
    const one = (s: string) => [...new Set(contentTokens(s, 'en'))];
    expect(one('refund refunds refunded refundable')).toEqual(['refund']);
    expect(one('cancel canceled cancelled cancelling cancellation')).toEqual(['cancel']);
    expect(one('policy policies')).toEqual(['policy']);
    expect(contentTokens('what if an event gets cancelled', 'en')).toEqual(contentTokens('event canceled', 'en'));
  });

  it('reads contractions and possessives: no stray letter, and the stop word stays out', () => {
    expect(contentTokens("I can't come", 'en')).toEqual(contentTokens('come', 'en'));
    expect(contentTokens('I don’t have my passes', 'en')).toEqual(contentTokens('passes', 'en'));
    expect(contentTokens("Wrenfield's refund", 'en')).toEqual(['wrenfield', 'refund']);
  });

  it('scores the question and the answer: "refund policy" meets the canceled question through its answer', () => {
    const canceled = passagesOf(FAQ).find((p) => p.path === `mainEntity[${CANCELED.i}]`)!;
    expect(contentTokens(canceled.text, 'en')).toContain('refund');
    expect(contentTokens(canceled.label!, 'en')).not.toContain('refund');
  });
});

describe('matching the FAQ', () => {
  it('"How does the refund policy work?", over the server\'s real rows: both refund questions reach the compose, and it answers', async () => {
    const { model: m } = model({
      query: 'refund policy',
      compose: [(shown) => (expect(shown).toEqual(expect.arrayContaining([`mainEntity[${REFUND.i}]`, `mainEntity[${CANCELED.i}]`])), quote(REFUND))],
    });
    const turn = await ask(agent(records(() => HELP_ROWS['refund policy']), m), 'How does the refund policy work?');
    expect(textOf(turn.message?.parts)).toBe(faqReply(REFUND));
  });

  it('"what if an event gets cancelled": the forms meet, so the canceled question leads, from a row with no located passage', async () => {
    const { model: m } = model({ query: 'what if an event gets cancelled', compose: [(shown) => (expect(shown[0]).toBe(`mainEntity[${CANCELED.i}]`), quote(CANCELED))] });
    const turn = await ask(agent(records(() => [PLAIN_ROW]), m), 'what if an event gets cancelled');
    expect(textOf(turn.message?.parts)).toBe(faqReply(CANCELED));
  });

  it('an exact phrasing answers, one rewrite and one compose', async () => {
    const { model: m } = model({ query: 'Are fees and taxes included in the price?', compose: [(shown) => (expect(shown[0]).toBe(`mainEntity[${FEES.i}]`), quote(FEES))] });
    const exec = agent(records(() => HELP_ROWS['Are fees and taxes included in the price?']), m);
    const turn = await ask(exec, 'Are fees and taxes included in the price?');
    expect(textOf(turn.message?.parts)).toBe(faqReply(FEES));
    expect(exec.lastTrace).toMatchObject({ rewrites: 1, composes: 1 });
  });

  it('no candidates: the not-found reply, as before, with no compose', async () => {
    const { model: m } = model({ query: 'parking at the venue' });
    const turn = await ask(agent(records(() => []), m), 'Where do I park?');
    expect(textOf(turn.message?.parts)).toBe(`I couldn't find that in Wrenfield Events's help content. I searched for "parking at the venue". Would you like me to pass your question to the team?`);
    expect(m.compose).not.toHaveBeenCalled();
  });

  it('the first turn after a handoff that finds nothing is still greeted, as before', async () => {
    const { model: m } = model({ query: 'parking at the venue' });
    const turn = await agent(records(() => []), m).turn('t', [user('The visitor wants to know where to park.', true)]);
    expect(textOf(turn.message?.parts)).toBe("Hi, I'm Wrenfield Help. What can I help you with?");
    expect(m.compose).not.toHaveBeenCalled();
  });
});

describe('why a turn ended not found, in the logs', () => {
  it('the compose step called not_found: said so, with the passages shown, and no visitor text', async () => {
    const log = logs();
    const { model: m } = model({ query: 'refund policy', compose: [{ kind: 'not_found', searched: 'refund policy' }] });
    const turn = await ask(agent(records(() => HELP_ROWS['refund policy']), m), 'How does the refund policy work?');
    expect(textOf(turn.message?.parts)).toMatch(/^I couldn't find that in Wrenfield Events's help content\./);
    expect(log.lines()).toEqual(['[support] not found: the compose step called not_found (attempt 1, 6 passages shown)']);
    log.restore();
  });

  it('the grounding check refused a non-verbatim FAQ answer, retried once, then not found: each refusal and the end are logged', async () => {
    const log = logs();
    const paraphrase: SupportDecision = { kind: 'answer', claims: [{ text: 'You get your money back up to 14 days before, at https://evil.example.', cites: [{ id: FAQ_ID, path: `mainEntity[${REFUND.i}]` }] }] };
    const { model: m, seen } = model({ query: 'refund policy', compose: [paraphrase, paraphrase] });
    const turn = await ask(agent(records(() => HELP_ROWS['refund policy']), m), 'How does the refund policy work? My email is ann@example.com');
    expect(textOf(turn.message?.parts)).toMatch(/^I couldn't find that in Wrenfield Events's help content\./);
    expect(seen.compose).toHaveLength(2);
    const lines = log.lines();
    expect(lines).toEqual([
      expect.stringMatching(/^\[support\] answer refused by the grounding check \(attempt 1\): /),
      expect.stringMatching(/^\[support\] answer refused by the grounding check \(attempt 2\): /),
      '[support] not found: every answer was refused by the grounding check',
    ]);
    // No word of the visitor's message, the model's claim or a record.
    expect(lines.join('\n')).not.toMatch(/refund|money|ann@|evil|wrenfield|14/i);
    log.restore();
  });

  it('a refusal reason is logged with its quoted values and links cut', () => {
    expect(refusalForLog('Claim 1 must quote the FAQ answer exactly as written.')).toBe('Claim 1 must quote the FAQ answer exactly as written.');
    expect(refusalForLog('Claim 2 says "14", which no cited passage says.')).toBe('Claim 2 says "…", which no cited passage says.');
    expect(refusalForLog("Claim 1 links to https://evil.example/x, which isn't a cited record's link.")).toBe("Claim 1 links to <link>, which isn't a cited record's link.");
    expect(refusalForLog('Claim 1 cites my secret id, which was not fetched this turn.')).toBe('Claim 1 cites <id>, which was not fetched this turn.');
    expect(refusalForLog('Claim 1 names evil.example, which isn\'t one of the site\'s links.')).toBe("Claim 1 names <link>, which isn't one of the site's links.");
  });
});
