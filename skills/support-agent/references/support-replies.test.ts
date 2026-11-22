/**
 * support-replies.test.ts — the owner's replies (vitest): the templates a site may reword, the advice line and the
 * emergency line, over the site's adapter, with fake records and a scripted model. Nothing here changes how it
 * finds and cites answers: the other tests run on the adapter as it was.
 *
 * Fix the imports to where the project put each file.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EMERGENCY,
  OWNER_TEMPLATES,
  defaultRole,
  SupportExecutor,
  extensionPart,
  findExtension,
  ownerTemplateDefault,
  ownerTemplateErrors,
  ownerTemplates,
  textOf,
  withOwnerReplies,
  type Message,
  type OwnerReplies,
  type RecordRow,
  type SupportModel,
  type SupportRecords,
} from './support-core';
import { exampleSite } from './example-site';

const ORIGIN = 'https://fixture.example';
const FAQ_ID = `${ORIGIN}/help/filter-faq`;
const WASH = "No. The X200-F filter can't be washed or rinsed, because water damages the HEPA layer and the carbon.";
const FAQ = { '@id': FAQ_ID, '@type': 'FAQPage', name: 'Filter FAQ', url: FAQ_ID, mainEntity: [{ '@type': 'Question', name: 'Can I wash the filter?', acceptedAnswer: { '@type': 'Answer', text: WASH } }] };

/** Fake read tools: no help content, or with `faq`, one FAQ. */
function records(faq: boolean): SupportRecords {
  return {
    query: async (args) => (faq && args.filter.schema_type !== 'Product' && args.filter.schema_type !== 'ContactPage' ? [{ '@id': FAQ_ID, '@type': 'FAQPage', url: FAQ_ID, name: 'Filter FAQ' } as RecordRow] : []),
    get: async (id) => (faq && id === FAQ_ID ? FAQ : null),
    listTypes: async () => [],
  };
}

/** A scripted model: the rewrite echoes a query; the compose finds nothing, or with `answer` quotes the FAQ. No real model is called. */
function model(o: { query?: string; answer?: boolean } = {}): SupportModel & { rewrite: ReturnType<typeof vi.fn>; compose: ReturnType<typeof vi.fn> } {
  const query = o.query ?? 'solar panels';
  return {
    rewrite: vi.fn(async () => query),
    compose: vi.fn(async () =>
      o.answer ? { kind: 'answer' as const, claims: [{ text: WASH, cites: [{ id: FAQ_ID, path: 'mainEntity[0]' }] }] } : { kind: 'not_found' as const, searched: query },
    ),
  };
}

function agent(replies?: OwnerReplies, o: { person?: boolean; query?: string; answer?: boolean } = {}) {
  const base = exampleSite({ records: records(!!o.answer), person: o.person ?? false, gaps: null, gapReports: false, turns: null });
  const m = model(o);
  return { exec: new SupportExecutor(withOwnerReplies(base, replies), () => m), model: m, base };
}

const user = (text: string, envelope?: Record<string, unknown>): Message => ({
  messageId: crypto.randomUUID(),
  role: 'ROLE_USER',
  parts: [{ text }, ...(envelope ? [extensionPart({ handoff: 'envelope', reason: 'The visitor asked for support.', ...envelope })] : [])],
});
const reply = (text: string): Message => ({ messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text }] });

/** A turn after the handoff's: the handoff, a greeting, then `text`. */
async function laterTurn(exec: SupportExecutor, text: string) {
  const task = crypto.randomUUID();
  await exec.turn(task, [user('talk to support', {})]);
  return exec.turn(task, [user('talk to support', {}), reply('Hi.'), user(text)]);
}

describe('the templates a site may reword', () => {
  it('lists exactly these keys, each with its placeholders', () => {
    expect(Object.keys(OWNER_TEMPLATES)).toEqual(['greeting', 'notFound', 'notFoundBare', 'screened', 'account', 'handBackPerson', 'handBackNoPerson', 'handBackNoPersonContact']);
    expect(OWNER_TEMPLATES.greeting.placeholders).toEqual(['label']);
    expect(OWNER_TEMPLATES.notFound.placeholders).toEqual(['site', 'searched']);
    expect(OWNER_TEMPLATES.handBackNoPersonContact.required).toEqual(['url']);
  });

  it('shows each default with its placeholders', () => {
    expect(ownerTemplateDefault('greeting')).toBe("Hi, I'm {label}. What can I help you with?");
    expect(ownerTemplateDefault('notFound')).toBe(`I couldn't find that in {site}'s help content. I searched for "{searched}".`);
    expect(ownerTemplateDefault('account')).toBe("I can't see accounts or orders.");
    expect(ownerTemplateDefault('handBackNoPersonContact')).toContain('{url}');
  });

  it('refuses an unknown key, a placeholder the key has not, a stray brace, a missing {url}, blank and over 300 characters', () => {
    expect(ownerTemplateErrors('greeting', 'Hello from {label}!')).toEqual([]);
    expect(ownerTemplateErrors('farewell', 'Bye')).toEqual(['farewell is not a template a site may reword']);
    expect(ownerTemplateErrors('greeting', 'Hi from {site}')).toEqual(['greeting may use {label}, not {site}']);
    expect(ownerTemplateErrors('account', 'No {label}')).toEqual(['account may use no placeholders, not {label}']);
    expect(ownerTemplateErrors('greeting', 'Hi {label')).toEqual(["greeting has a brace that isn't part of a placeholder"]);
    expect(ownerTemplateErrors('handBackNoPersonContact', 'See our contact page.')).toEqual(['handBackNoPersonContact must include {url}']);
    expect(ownerTemplateErrors('greeting', '  ')).toEqual(['greeting is empty']);
    expect(ownerTemplateErrors('greeting', 7)).toEqual(['greeting is empty']);
    expect(ownerTemplateErrors('greeting', 'a'.repeat(301))).toEqual(['greeting is longer than 300 characters']);
  });

  it('fills the placeholders, and leaves out what fails its check', () => {
    const t = ownerTemplates({ greeting: 'Hey, {label} here.', notFound: '{site} has nothing on "{searched}" ({site}).', account: 'No orders here.', farewell: 'Bye', screened: 'Only {nope}' });
    expect(t.greeting?.('Box office help')).toBe('Hey, Box office help here.');
    expect(t.notFound?.('Ridgeline Air', 'solar $& panels')).toBe('Ridgeline Air has nothing on "solar $& panels" (Ridgeline Air).');
    expect(t.account).toBe('No orders here.');
    expect(Object.keys(t).sort()).toEqual(['account', 'greeting', 'notFound']);
  });
});

describe('the owner’s replies, in a turn', () => {
  it('says the greeting override on the first turn, and the default without one', async () => {
    const { exec } = agent({ templates: { greeting: 'Welcome! {label} answers from our guides. What do you need?' } });
    const turn = await exec.turn('t', [user('talk to support', {})]);
    expect(textOf(turn.message?.parts)).toBe('Welcome! Ridgeline Help answers from our guides. What do you need?');
    const plain = agent({ templates: {} });
    expect(textOf((await plain.exec.turn('t', [user('talk to support', {})])).message?.parts)).toBe("Hi, I'm Ridgeline Help. What can I help you with?");
  });

  it('says the not-found override with the search filled in', async () => {
    const { exec } = agent({ templates: { notFound: 'Our guides at {site} don’t cover that yet (I looked for "{searched}").' } });
    const turn = await laterTurn(exec, 'does it work with solar panels?');
    expect(textOf(turn.message?.parts)).toContain('Our guides at Ridgeline Air don’t cover that yet (I looked for "solar panels").');
  });

  it('says the no-person hand-back override', async () => {
    const { exec } = agent({ templates: { handBackNoPerson: 'Nobody from the team is on here. Back to the assistant you go.' } });
    const turn = await laterTurn(exec, 'can I talk to a person');
    expect(textOf(turn.message?.parts)).toBe('Nobody from the team is on here. Back to the assistant you go.');
    expect(findExtension(turn.message?.parts, 'handback')).not.toBeNull();
  });

  it('says the emergency line in place of the adapter’s advice, still with no model', async () => {
    const { exec, model: m } = agent({ emergencyLine: 'Unplug it now and call 911 if there is smoke.' });
    const turn = await laterTurn(exec, 'it is sparking and there is smoke');
    expect(textOf(turn.message?.parts)).toBe('Unplug it now and call 911 if there is smoke.');
    expect(turn.outcome?.outcome).toBe('emergency');
    expect(m.rewrite).not.toHaveBeenCalled();
  });

  it('adds the advice line to an answer to an advice question', async () => {
    const { exec } = agent({ adviceLine: 'Please ask your own doctor about your situation.' }, { answer: true, query: 'wash the filter' });
    const turn = await laterTurn(exec, 'can I wash the filter? I have asthma');
    expect(textOf(turn.message?.parts)).toContain(WASH);
    expect(textOf(turn.message?.parts)).toContain('Please ask your own doctor about your situation.');
    expect(textOf(turn.message?.parts)).not.toContain('qualified professional');
  });

  it('keeps the adapter as it was when nothing is set, or only blanks and unknown keys', () => {
    const { base } = agent();
    expect(withOwnerReplies(base, undefined)).toBe(base);
    const same = withOwnerReplies(base, { templates: { farewell: 'Bye', greeting: ' ' }, adviceLine: '', emergencyLine: '   ' });
    expect(same.templates).toEqual({});
    expect(same.emergency).toBe(base.emergency);
    expect(same.advice).toBe(base.advice);
  });
});

describe('the neutral defaults, for a host with no adapter of the site’s own', () => {
  /** The example site with the neutral defaults in place of its own emergency handling and role. */
  const neutral = (replies?: OwnerReplies) => {
    const base = exampleSite({ records: records(false), person: false, gaps: null, gapReports: false, turns: null });
    const m = model();
    const site = withOwnerReplies({ ...base, siteName: 'Wrenfield', role: defaultRole('Wrenfield'), emergency: DEFAULT_EMERGENCY }, replies);
    return { exec: new SupportExecutor(site, () => m), model: m, site };
  };

  it('names no phone number in the emergency line', () => {
    expect(DEFAULT_EMERGENCY.advice).not.toMatch(/\d/);
    expect(DEFAULT_EMERGENCY.advice).toMatch(/local emergency services/);
  });

  for (const phrase of ["There's smoke coming out of my purifier!", 'it is sparking and there is smoke', 'my purifier is sparking and there is smoke', 'my friend is not breathing', 'I want to kill myself', 'I can smell gas in the kitchen', 'the heater caught fire']) {
    it(`catches "${phrase}"`, () => expect(DEFAULT_EMERGENCY.pattern.test(phrase.toLowerCase())).toBe(true));
  }

  for (const phrase of ['How do I test my smoke alarm?', 'Is the toy a choking hazard?', 'How do I adjust the flame height?', 'Do you sell gas grills?', 'What is your emergency cancellation policy?']) {
    it(`leaves "${phrase}" to the help content`, () => expect(DEFAULT_EMERGENCY.pattern.test(phrase.toLowerCase())).toBe(false));
  }

  it('says the neutral line for an emergency, with no model, and no number', async () => {
    const { exec, model: m } = neutral();
    const turn = await laterTurn(exec, 'there is smoke coming from the stage');
    expect(textOf(turn.message?.parts)).toBe(DEFAULT_EMERGENCY.advice);
    expect(textOf(turn.message?.parts)).not.toMatch(/\d/);
    expect(turn.outcome?.outcome).toBe('emergency');
    expect(m.rewrite).not.toHaveBeenCalled();
  });

  it('says the owner’s emergency line over the neutral one', async () => {
    const { exec } = neutral({ emergencyLine: 'Call 911 now, then tell a member of staff.' });
    const turn = await laterTurn(exec, 'someone is having a heart attack');
    expect(textOf(turn.message?.parts)).toBe('Call 911 now, then tell a member of staff.');
  });

  it('gives a role that names the site', () => {
    expect(defaultRole('Wrenfield')).toBe("answers questions from Wrenfield's help content");
  });
});
