/**
 * agent-core.ts — a quote-request agent behind a handoff, site-neutral.
 *
 * Copy this file into the project unchanged. Everything about the site — who a
 * quote is from, what a request asks for, what counts as an emergency, where a
 * request goes — comes from a `QuoteSite` the project writes (see
 * example-site.ts). Where it is served comes from a thin host file (hosts/).
 *
 * Generalized from a working quote agent for a directory of local contractors,
 * without changing what it does.
 *
 * Each turn is at most one model decision — ask the visitor one thing, say the
 * request is ready, or hand back. Around it, the parts that must not depend on
 * a model are rules:
 *
 * - which provider: from the page the visitor was on, or matched by name when
 *   they say one;
 * - whether the request is complete: `missing()` checks every value the model
 *   offers (required fields, email shape, phone digits, choices), and asks for
 *   whatever fails;
 * - an emergency: never a quote — hand back with the provider's phone;
 * - sending: only after the visitor has read a summary written from the values
 *   themselves and said a plain yes, in their next message; once per task,
 *   never retried. The confirmation and the reference come from what the
 *   site's sink answered, never from the model.
 *
 * It reads the handoff envelope from the first message and never asks for
 * what it already says, asks with TASK_STATE_INPUT_REQUIRED, and finishes with
 * a hand-back — the harness's docs/handoff.md, "Writing a target".
 *
 * Depends on `@a2a-js/sdk` (server side) only. The model is behind
 * `QuoteModel`; `claudeModel` adapts `@anthropic-ai/sdk`'s client without
 * importing it.
 */
import {
  AgentEvent,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  UnauthenticatedUser,
  defaultServerCallContextBuilder,
  validateVersion,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { AgentCard, Message as SdkMessage, Task as SdkTask, TaskStatusUpdateEvent } from '@a2a-js/sdk';

// ── A2A on the wire, as much as this file needs ─────────────────────────────

export const HANDOFF_EXTENSION = 'https://nxis.ai/a2a/handoff/v1';

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

export interface Part {
  text?: string;
  data?: unknown;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  messageId: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: Part[];
  taskId?: string;
  contextId?: string;
}

/** A data part carrying the handoff extension. */
export const extensionPart = (data: Record<string, unknown>): Part => ({
  data,
  mediaType: 'application/json',
  metadata: { extension: HANDOFF_EXTENSION },
});

/** The extension data of a given kind (`envelope`, `handback`, …) in some parts. */
export function findExtension(parts: Part[] = [], kind: string): Record<string, unknown> | null {
  for (const p of parts) {
    const data = p.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object' && data.handoff === kind) return data;
  }
  return null;
}

/** The text parts of a message, joined. */
export const textOf = (parts: Part[] = []): string =>
  parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();

export const agentMessage = (text: string, extra: Part[] = []): Message => ({
  messageId: crypto.randomUUID(),
  role: 'ROLE_AGENT',
  parts: [...(text ? [{ text }] : []), ...extra],
});

// ── The site, as the agent sees it ──────────────────────────────────────────

/** One thing a quote request carries, as the site's own form asks for it. */
export interface QuoteField {
  /** The form's field name: the key it is posted under. */
  name: string;
  label: string;
  kind: 'text' | 'email' | 'phone' | 'choice' | 'longtext';
  required: boolean;
  /** For a choice: what may be sent, and how the visitor would say it. */
  options?: { value: string; label: string }[];
}

/** Who the quote is from: the business that will answer it. */
export interface Provider {
  id: string;
  name: string;
  /** Said to a visitor with an emergency, and when sending fails. */
  phone: string;
}

/** The page the visitor was on when they were handed over, from the envelope. */
export interface HandoffPage {
  url?: string;
  title?: string;
  /** The page's JSON-LD `@id`, when it has one. */
  entity?: string;
}

/** What a submission came to. `reference` only when the sink returned one — never made up. */
export type Submitted = { ok: true; reference?: string } | { ok: false; error: string };

export interface QuoteSite {
  /** The agent's own name, as its Agent Card and the relay label say it: "Royal Oak Quotes". */
  agentName: string;
  /** What it does, after "the agent that": "sends quote requests to contractors for a local directory". */
  role: string;
  /** What to call a provider when asking which one: "contractor", "office". */
  providerNoun: string;
  /**
   * The provider a page is about; null for a page about none. A site with one
   * business returns it for every page.
   */
  providerAt(page: HandoffPage | undefined): Provider | null;
  /** Providers a visitor's words name, best first; ties all returned. A site with one business returns []. */
  match(text: string): Provider[];
  /** What a request to this provider asks for: the same fields, options and requirements as the site's form. */
  fields(provider: Provider): QuoteField[];
  /** Facts for the model: what the site is, what this provider does, where it works. */
  facts(provider: Provider): string;
  /** Extra prompt lines for this site's fields: what to ask about when it isn't clear, what's optional. */
  guidance: string[];
  emergency: {
    /** Words (lower-cased text) that mean it can't wait for a quote. */
    pattern: RegExp;
    /** For the model: "flooding, a burst pipe, a gas smell, no heat, sparking, locked out". */
    examples: string;
    /** Field values that mean the same, by the visitor's own account: `{ timeline: ['emergency'] }`. */
    values?: Record<string, string[]>;
    /** A safety line after the call-them advice, or ''. */
    advice: string;
    /** Who to call when no provider is settled yet, after "please ". */
    noProvider: string;
    /** The provider's emergency line (a 24-hour number), when it has one apart from its main phone. */
    phone?: string;
  };
  /** Where the visitor can still send it themselves, as a phrase: "the quote form on their page". */
  fallback(provider: Provider | null): string;
  /** Send the request, exactly as the site's own form would. Called at most once per task. */
  submit(provider: Provider, values: Record<string, string>): Promise<Submitted>;
}

// ── The model ───────────────────────────────────────────────────────────────

/** What the model decided this turn. */
export type QuoteDecision =
  | { action: 'ask'; question: string }
  | { action: 'ready'; values: Record<string, string> }
  | { action: 'hand_back'; outcome: 'unresolved' | 'transferred'; note: string; message: string };

/** The model, behind the one call the agent makes per turn. Tests script it. */
export interface QuoteModel {
  decide(input: { system: string; messages: { role: 'user' | 'assistant'; content: string }[]; fields: QuoteField[] }): Promise<QuoteDecision>;
}

export function systemPrompt(site: QuoteSite, provider: Provider, fields: QuoteField[]): string {
  const spec = fields.map(
    (f) =>
      `${f.name} (${f.label}${f.required ? ', required' : ', optional'}${
        f.options ? `; one of: ${f.options.map((o) => `"${o.value}" = ${o.label}`).join(', ')}` : ''
      })`,
  );
  const longtext = fields.filter((f) => f.kind === 'longtext').map((f) => f.name);
  return [
    `You are ${site.agentName}, the agent that ${site.role}. This request is for ${provider.name}.`,
    "An on-page assistant has handed you this visitor. The first message carries its summary; never ask for anything it already tells you.",
    site.facts(provider),
    `A request carries: ${spec.join('; ')}.`,
    'Each turn, call exactly one tool. ask_visitor asks ONE question — never two in one message — briefly and warmly, in plain text. ready passes every value you have once the required ones are known. hand_back returns the visitor to the assistant.',
    ...site.guidance,
    `For a choice, pass its value, not its label.${
      longtext.length ? ` For ${longtext.join(' and ')}, write what the visitor told you about the job in their words; do not embellish.` : ''
    }`,
    `Never invent a value the visitor did not give. Never quote a price or promise a time — the ${site.providerNoun} does that.`,
    `Only what the visitor needs now counts as an emergency: something earlier in the conversation that they have moved on from is not one. If something is an emergency now — ${site.emergency.examples} — do not take a request: hand_back with outcome unresolved and tell them to ${emergencyCall(site, provider)}.`,
    'If they want something other than a quote, hand_back with outcome transferred.',
  ].join(' ');
}

// ── Rules ───────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Words a plain yes is made of. A reply of only these, with at least one that agrees, sends the request. */
const AGREE = new Set(['y', 'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'confirmed', 'correct', 'send', 'perfect', 'great', 'good']);
const FILLER = new Set(['it', 'go', 'ahead', 'please', 'thanks', 'thank', 'you', 'looks', 'that', "that's", 'thats', 'is', 'right', 'do', 'all', 'fine', 'and', 'the', 'request']);
/** Whether a reply is a plain yes: anything else — "yes but…", a correction — is not. */
export function isYes(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  return words.some((w) => AGREE.has(w)) && words.every((w) => AGREE.has(w) || FILLER.has(w));
}
/** A no to the summary. */
const NO = /^\s*(no|nope|cancel|stop|never ?mind|don'?t send( it)?|forget it)\b[\s.!,]*$/i;
/** Stopping at any point. A bare "no" isn't one: it answers questions ("a phone number?" "no"). */
const QUIT = /^\s*(cancel|stop|never ?mind|forget it|i changed my mind)\b/i;

/** A value the visitor gave for a choice, as the value the form posts; undefined when it isn't one. */
function choose(field: QuoteField, given: string): string | undefined {
  const g = given.trim().toLowerCase();
  return field.options?.find((o) => o.value.toLowerCase() === g || o.label.toLowerCase() === g)?.value;
}

/** The model's values, tidied: trimmed, choices as their values, unknown names dropped. */
export function normalize(fields: QuoteField[], raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = typeof raw[f.name] === 'string' ? (raw[f.name] as string).trim() : '';
    if (!v) continue;
    out[f.name] = f.kind === 'choice' ? (choose(f, v) ?? v) : v;
  }
  return out;
}

/** Why values can't be sent yet, as the question to ask; null when they can. */
export function missing(fields: QuoteField[], values: Record<string, string>): string | null {
  for (const f of fields) {
    const v = values[f.name]?.trim() ?? '';
    if (!v) {
      if (f.required) return questionFor(f);
      continue;
    }
    if (f.kind === 'email' && !EMAIL.test(v)) return "That email address doesn't look right — what's the best one for the quote to go to?";
    if (f.kind === 'phone') {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 11) return "What's the best phone number, with the area code? (Or say no if you'd rather not give one.)";
    }
    if (f.kind === 'choice' && !f.options?.some((o) => o.value === v)) return questionFor(f);
  }
  return null;
}

function questionFor(f: QuoteField): string {
  switch (f.kind) {
    case 'email':
      return 'What email address should the quote go to?';
    case 'phone':
      return "What's the best phone number, with the area code?";
    case 'choice':
      return `Which fits best for ${f.label.toLowerCase()}: ${f.options!.map((o) => o.label).join(', ')}?`;
    case 'longtext':
      return 'Could you tell me a little about the job — what needs doing, and anything they should know?';
    default:
      return /(^|_)name$/.test(f.name) ? 'What name should the request be under?' : `What should I put for ${f.label.toLowerCase()}?`;
  }
}

/** The values, as the visitor reads them before saying yes. Written from the values, not by the model. */
export function summary(provider: Provider, fields: QuoteField[], values: Record<string, string>): string {
  const lines = fields
    .filter((f) => values[f.name])
    .map((f) => `• ${f.label}: ${f.options?.find((o) => o.value === values[f.name])?.label ?? values[f.name]}`);
  return `Here's the quote request for ${provider.name}:\n${lines.join('\n')}\n\nShall I send it? Say yes to send, or tell me what to change.`;
}

/** Who the request is from and how they'll hear back, from the values: the first name-like, email and phone fields. */
function contactOf(fields: QuoteField[], values: Record<string, string>) {
  const first = (pick: (f: QuoteField) => boolean) => fields.filter(pick).map((f) => values[f.name]).find(Boolean);
  return {
    name: first((f) => f.kind === 'text' && /(^|_)name$/.test(f.name)) ?? first((f) => f.kind === 'text' && f.required),
    email: first((f) => f.kind === 'email'),
    phone: first((f) => f.kind === 'phone'),
  };
}

/** What a message says, as the model should read it. */
function readable(message: Message): string {
  const envelope = findExtension(message.parts, 'envelope');
  if (!envelope) return textOf(message.parts);
  const lines = ["[Handed off by the site's assistant]", `Reason: ${envelope.reason ?? ''}`, `Summary: ${envelope.summary ?? ''}`];
  const page = envelope.page as HandoffPage | undefined;
  if (page?.url) lines.push(`Page: ${page.title ?? ''} ${page.url}`);
  for (const f of (envelope.facts as { name: string; value: string }[] | undefined) ?? []) lines.push(`${f.name}: ${f.value}`);
  const contact = envelope.contact as Record<string, string> | undefined;
  if (contact) lines.push(`Contact: ${Object.entries(contact).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return lines.join('\n');
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the emergency rule reads of a message: the visitor's words, or for the handoff only its reason. The summary
 * tells the whole conversation, so an emergency earlier in it that the visitor has moved on from would stick; the
 * model reads the summary and judges whether one is still going on.
 */
function urgentText(message: Message | undefined): string {
  if (!message) return '';
  const envelope = findExtension(message.parts, 'envelope');
  return withoutTheLine(envelope ? String(envelope.reason ?? '') : textOf(message.parts));
}

/**
 * Words that only name the business's line or service for emergencies ("its emergency line is …", "the 24-hour
 * service"): a note or a question that mentions them is not an emergency. Taken out before the emergency rule reads
 * a message, so only what is happening to the visitor counts.
 */
const THE_LINE = /\b(?:emergency|24[\s/-]*(?:hours?|hrs?|7))[\s-]+(?:line|number|phone|service|dispatch|contact)s?\b/gi;
export const withoutTheLine = (text: string): string => text.replace(THE_LINE, ' ');

/** "Copperline's", "Copperline Home Services'": a name's possessive. */
export const possessive = (name: string): string => (/s$/i.test(name.trim()) ? `${name}'` : `${name}'s`);

/** "call <provider>'s emergency line at <number>", or its main phone when it has none. */
const emergencyCall = (site: Pick<QuoteSite, 'emergency'>, provider: Provider) =>
  site.emergency.phone ? `call ${possessive(provider.name)} emergency line now at ${site.emergency.phone}` : `call ${provider.name} now at ${provider.phone}`;

// ── What a task has settled ─────────────────────────────────────────────────

/** What a task has settled so far. JSON, so a host with many instances can keep it in a store. */
export interface Progress {
  provider?: Provider;
  /** Values the visitor has been shown and asked to confirm; cleared by anything but a yes. */
  pending?: Record<string, string>;
  /** Set before the sink is called, so nothing is ever sent twice. */
  submitted?: boolean;
  /** The sink's reference, once it has answered, so a second "yes" can repeat it. */
  reference?: string;
  /** The sink refused or failed: nothing was sent, and a second "yes" must not say it was. */
  sendFailed?: boolean;
}

/**
 * Where progress lives between turns. In memory on a single long-lived
 * process; in the host's key-value store where requests land on different
 * instances (a serverless function), or the summary a visitor said yes to is
 * gone when the yes arrives.
 */
export interface ProgressStore {
  get(taskId: string): Promise<Progress | null>;
  set(taskId: string, progress: Progress): Promise<void>;
  delete(taskId: string): Promise<void>;
  /**
   * Mark the task submitted, and say whether this call did it. Only the call
   * that gets true may send. With a store that has conditional writes, use
   * them here.
   */
  claim(taskId: string): Promise<boolean>;
}

/**
 * What a completed task keeps. One that sent (or tried to) keeps only how that ended, so a "yes"
 * still in flight on another request can repeat the reference rather than miss it; the store's
 * expiry removes it later. Anything else, and every value the visitor gave, goes.
 */
export function afterCompleted(p: Progress | null): Progress | null {
  if (!p?.submitted) return null;
  return { submitted: true, ...(p.reference ? { reference: p.reference } : {}), ...(p.sendFailed ? { sendFailed: true } : {}) };
}

export function memoryProgress(): ProgressStore {
  const map = new Map<string, Progress>();
  // Copies in and out, as a store over the wire would: two turns on one task at once (a double "yes")
  // must each read the task as it was, not watch the other change it.
  const copy = (p: Progress): Progress => JSON.parse(JSON.stringify(p));
  return {
    get: async (id) => { const p = map.get(id); return p ? copy(p) : null; },
    set: async (id, p) => void map.set(id, copy(p)),
    delete: async (id) => void map.delete(id),
    async claim(id) {
      const p = map.get(id) ?? {};
      if (p.submitted) return false;
      map.set(id, { ...p, submitted: true });
      return true;
    },
  };
}

// ── The executor ────────────────────────────────────────────────────────────

type Turn = { state: TaskState; message: Message };

const ask = (text: string): Turn => ({ state: 'TASK_STATE_INPUT_REQUIRED', message: agentMessage(text) });

const handBack = (text: string, outcome: 'resolved' | 'unresolved' | 'transferred', note: string, references: { label: string; value: string }[] = []): Turn => ({
  state: 'TASK_STATE_COMPLETED',
  message: agentMessage(text, [extensionPart({ handoff: 'handback', outcome, note, references })]),
});

/** How long a "yes" that lost the claim waits for the winner's reference: about as long as a sink takes to answer. */
const ALREADY_SENT_WAIT_MS = 8_000;

/** The hand-back for a request that was already sent, with its reference when the sink gave one. */
const alreadySent = (reference?: string): Turn =>
  handBack(
    `Your request has already been sent.${reference ? ` Reference ${reference}.` : ''}`,
    'resolved',
    `The quote request was already sent.${reference ? ` Reference ${reference}.` : ''}`,
    reference ? [{ label: 'Quote reference', value: reference }] : [],
  );

/** The SDK's objects in the plain A2A JSON this file reasons about. */
const wire = {
  message: (m: SdkMessage) => SdkMessage.toJSON(m) as unknown as Message,
  history: (t: SdkTask) => (SdkTask.toJSON(t) as unknown as { history?: Message[] }).history ?? [],
};

export class QuoteExecutor implements AgentExecutor {
  /**
   * `model` is read each turn: null means no model is configured, and the
   * agent says so (the relay should already list it as unavailable).
   */
  constructor(
    private readonly site: QuoteSite,
    private readonly model: () => QuoteModel | null,
    private readonly store: ProgressStore = memoryProgress(),
  ) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;
    const user = wire.message(ctx.userMessage);
    const prior = ctx.task ? wire.history(ctx.task) : [];
    const history = prior.some((m) => m.messageId === user.messageId) ? prior : [...prior, user];
    const at = () => new Date().toISOString();

    // First event of every call: the task, working.
    bus.publish(AgentEvent.task(SdkTask.fromJSON({ id: taskId, contextId, status: { state: 'TASK_STATE_WORKING', timestamp: at() }, history })));
    const say = (state: TaskState, message: Message) =>
      bus.publish(
        AgentEvent.statusUpdate(
          TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state, message: { ...message, taskId, contextId }, timestamp: at() } }),
        ),
      );
    try {
      const turn = await this.turn(taskId, history);
      say(turn.state, turn.message);
      if (turn.state === 'TASK_STATE_COMPLETED') {
        const kept = afterCompleted(await this.store.get(taskId));
        await (kept ? this.store.set(taskId, kept) : this.store.delete(taskId));
      }
    } catch (err) {
      console.error('[quote] turn failed:', err);
      say('TASK_STATE_FAILED', agentMessage(`Sorry — I couldn't finish that. ${capital(this.site.fallback(null))} still works.`));
    } finally {
      bus.finished();
    }
  }

  /** One turn: settle the provider, catch an emergency, confirm or send, or let the model ask. */
  async turn(taskId: string, history: Message[]): Promise<Turn> {
    const progress: Progress = (await this.store.get(taskId)) ?? {};
    try {
      return await this.decide(taskId, progress, history);
    } finally {
      // Whatever the turn settled (the provider, a summary awaiting a yes) is there for the next one.
      if (!progress.submitted) await this.store.set(taskId, progress);
    }
  }

  private async decide(taskId: string, progress: Progress, history: Message[]): Promise<Turn> {
    const site = this.site;
    const last = history[history.length - 1];
    const lastText = last ? readable(last) : '';
    const envelope = history.map((m) => findExtension(m.parts, 'envelope')).find(Boolean);
    const said = history.filter((m) => m.role === 'ROLE_USER').map(readable).join('\n');

    // A second "yes" that reads the task after the winner claimed it, while the winner still waits
    // on the sink: wait for how that send ended, as a "yes" that loses the claim does.
    if (progress.submitted && !progress.reference && !progress.sendFailed) {
      const settled = await this.settled(taskId);
      if (settled) Object.assign(progress, { reference: settled.reference, sendFailed: settled.sendFailed });
    }
    if (progress.submitted && progress.sendFailed) {
      return handBack(
        `Sorry — that request couldn't be sent. ${capital(site.fallback(progress.provider ?? null))} still works.`,
        'unresolved',
        `Sending the quote request failed earlier. Nothing was sent; ${site.fallback(progress.provider ?? null)} still works.`,
      );
    }
    if (progress.submitted) return alreadySent(progress.reference);

    if (last && !findExtension(last.parts, 'envelope') && QUIT.test(textOf(last.parts))) {
      return handBack("No problem — I haven't sent anything. I'll pass you back to the assistant.", 'transferred', 'The visitor stopped before a quote request was sent.');
    }

    // Who the quote is from: the page they were on, or the one they name.
    if (!progress.provider) {
      const found = site.match(said);
      progress.provider = site.providerAt(envelope?.page as HandoffPage | undefined) ?? (found.length === 1 ? found[0] : undefined);
    }
    const provider = progress.provider;

    // An emergency is a phone call, not a quote.
    if (site.emergency.pattern.test(urgentText(last).toLowerCase())) {
      const call = provider ? emergencyCall(site, provider) : site.emergency.noProvider;
      return handBack(
        `That sounds like an emergency — please ${call} rather than waiting on a quote.${site.emergency.advice ? ` ${site.emergency.advice}` : ''}`,
        'unresolved',
        `The visitor described an emergency; told them to ${call}. No quote request was sent.`,
      );
    }

    if (!provider) {
      const found = site.match(said);
      return ask(
        found.length > 1
          ? `Which ${site.providerNoun} should the quote come from — ${found.slice(0, 4).map((c) => c.name).join(', ')}?`
          : `Which ${site.providerNoun} would you like a quote from? Tell me their name.`,
      );
    }

    // Nothing said: nothing for the rules or the model to read.
    if (last && !lastText.trim()) return ask("Sorry, I didn't catch that — could you say it again?");

    const fields = site.fields(provider);

    // The visitor has read the summary: a yes sends it, a no stops, anything else is a change.
    if (progress.pending) {
      const text = last ? textOf(last.parts) : '';
      if (isYes(text)) return this.send(taskId, progress, provider, fields, progress.pending);
      progress.pending = undefined;
      if (NO.test(text)) {
        return handBack("Okay — I haven't sent anything. I'll pass you back to the assistant.", 'unresolved', 'The visitor decided not to send the quote request. Nothing was sent.');
      }
    }

    const model = this.model();
    if (!model) {
      return handBack(
        `I can't take quote requests right now. ${capital(site.fallback(provider))} still works.`,
        'unresolved',
        'The quote agent has no model configured. Nothing was sent.',
      );
    }

    const decision = await model.decide({
      system: systemPrompt(site, provider, fields),
      messages: history
        .map((m) => ({ role: m.role === 'ROLE_AGENT' ? ('assistant' as const) : ('user' as const), content: readable(m) }))
        .filter((m) => m.content),
      fields,
    });

    if (decision.action === 'ask') return ask(decision.question);
    if (decision.action === 'hand_back') return handBack(decision.message, decision.outcome, decision.note);

    const values = normalize(fields, decision.values);
    // A value that means "right now" is an emergency by the visitor's own account.
    const urgent = Object.entries(site.emergency.values ?? {}).some(([name, means]) => values[name] !== undefined && means.includes(values[name]));
    if (urgent) {
      return handBack(
        `For something that needs doing right now, please ${emergencyCall(site, provider)} — that's faster than a quote.`,
        'unresolved',
        `The visitor needs help right now; told them to ${emergencyCall(site, provider)}. No quote request was sent.`,
      );
    }
    const gap = missing(fields, values);
    if (gap) return ask(gap);
    progress.pending = values;
    return ask(summary(provider, fields, values));
  }

  /** Send once, and say what came of it. */
  private async send(taskId: string, progress: Progress, provider: Provider, fields: QuoteField[], values: Record<string, string>): Promise<Turn> {
    progress.pending = undefined;
    // Claimed before the sink is called: a retry, a second instance or a double "yes" never sends again.
    if (!(await this.store.claim(taskId))) {
      progress.submitted = true;
      // The winner is usually still waiting on the sink. Wait for its reference rather than answer
      // without one: whichever reply the relay keeps then carries it.
      const settled = await this.settled(taskId);
      if (settled?.sendFailed) {
        return handBack(
          `Sorry — I couldn't send that to ${provider.name}. ${capital(this.site.fallback(provider))} still works, or call them at ${provider.phone}.`,
          'unresolved',
          `Sending the quote request to ${provider.name} failed. Nothing was sent; ${this.site.fallback(provider)} still works.`,
        );
      }
      return alreadySent(settled?.reference);
    }
    progress.submitted = true;
    let result: Submitted;
    try {
      result = await this.site.submit(provider, values);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      console.error('[quote] submission failed:', result.error);
      await this.store.set(taskId, { ...progress, submitted: true, sendFailed: true }).catch((err) => console.error('[quote] failure not kept:', err));
      return handBack(
        `Sorry — I couldn't send that to ${provider.name}. ${capital(this.site.fallback(provider))} still works, or call them at ${provider.phone}.`,
        'unresolved',
        `Sending the quote request to ${provider.name} failed (${result.error}). Nothing was sent; ${this.site.fallback(provider)} still works.`,
      );
    }
    // Kept for a second "yes" on this task, which lost the claim and would otherwise answer without it.
    await this.store.set(taskId, { ...progress, submitted: true, reference: result.reference }).catch((err) => console.error('[quote] reference not kept:', err));
    const { name, email, phone } = contactOf(fields, values);
    const ref = result.reference ? ` Reference ${result.reference}.` : '';
    const reach = email ?? phone;
    return handBack(
      `Sent to ${provider.name}.${ref} ${reach ? `They'll follow up at ${reach}.` : "They'll follow up with you."}`,
      'resolved',
      `Sent a quote request to ${provider.name}${name ? ` for ${name}` : ''}${reach ? ` (${reach})` : ''}.${ref}`,
      result.reference ? [{ label: 'Quote reference', value: result.reference }] : [],
    );
  }

  /**
   * How the winning send ended, once it has stored that: its reference, or that it failed. Null if
   * it hasn't within the wait (a sink with no reference, or a slow one).
   */
  private async settled(taskId: string): Promise<Progress | null> {
    const until = Date.now() + ALREADY_SENT_WAIT_MS;
    for (;;) {
      const stored = await this.store.get(taskId).catch(() => null);
      if (stored?.reference || stored?.sendFailed) return stored;
      if (Date.now() >= until) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    await this.store.delete(taskId);
    bus.publish(
      AgentEvent.statusUpdate(TaskStatusUpdateEvent.fromJSON({ taskId, status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() } })),
    );
    bus.finished();
  }
}

// ── Claude ──────────────────────────────────────────────────────────────────

/** The slice of `@anthropic-ai/sdk`'s client this uses. */
export interface MessagesClient {
  messages: { create(body: Record<string, unknown>): Promise<unknown> };
}

/**
 * The model, as Claude through Anthropic's API.
 *
 * Claude Sonnet 5.5 (like Opus 5.5 and Fable 5.1) answers a forced `tool_choice`
 * (`any` or `tool`) with a 400, so
 * the choice is `auto`, one call at most, with the prompt saying to call
 * exactly one tool. A reply in text instead is taken as the question it
 * almost always is.
 */
export function claudeModel(client: MessagesClient, model: string): QuoteModel {
  return {
    async decide({ system, messages, fields }) {
      const tools = [
        {
          name: 'ask_visitor',
          description: 'Ask the visitor for ONE missing detail, in plain text.',
          input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
        },
        {
          name: 'ready',
          description: 'Every required value is known: pass all the values you have. The visitor is shown a summary to confirm before anything is sent.',
          input_schema: {
            type: 'object',
            properties: {
              values: {
                type: 'object',
                properties: Object.fromEntries(
                  fields.map((f) => [
                    f.name,
                    { type: 'string', description: f.label, ...(f.options ? { enum: f.options.map((o) => o.value) } : {}) },
                  ]),
                ),
                required: fields.filter((f) => f.required).map((f) => f.name),
              },
            },
            required: ['values'],
          },
        },
        {
          name: 'hand_back',
          description: "Return the visitor to the site's assistant: for an emergency, or anything that isn't a quote request.",
          input_schema: {
            type: 'object',
            properties: {
              outcome: { type: 'string', enum: ['unresolved', 'transferred'] },
              note: { type: 'string', description: 'For the assistant: what happened.' },
              message: { type: 'string', description: 'For the visitor.' },
            },
            required: ['outcome', 'note', 'message'],
          },
        },
      ];
      const reply = (await client.messages.create({
        model,
        max_tokens: 2000,
        system,
        tools,
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        // A short conversational turn: little to think about.
        output_config: { effort: 'low' },
        messages,
      })) as { content: { type: string; name?: string; text?: string; input?: Record<string, unknown> }[] };
      const use = reply.content.find((b) => b.type === 'tool_use');
      const input = use?.input ?? {};
      if (use?.name === 'ready') return { action: 'ready', values: (input.values as Record<string, string>) ?? {} };
      if (use?.name === 'hand_back') {
        return {
          action: 'hand_back',
          outcome: input.outcome === 'unresolved' ? 'unresolved' : 'transferred',
          note: String(input.note ?? ''),
          message: String(input.message ?? "I'll pass you back to the assistant."),
        };
      }
      const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim();
      return { action: 'ask', question: String(input.question ?? (text || 'Could you tell me a little more about the job?')) };
    },
  };
}

// ── The Agent Card ──────────────────────────────────────────────────────────

export interface CardOptions {
  /** The origin it is served on, scheme included: the card points at `${origin}${path}`. */
  origin: string;
  /** The A2A endpoint's path: '/a2a/quote'. */
  path: string;
  name: string;
  /** One or two sentences: what it takes, and that it confirms before sending. */
  description: string;
  organization: string;
  /** What the skill collects, in a sentence, for the card's one skill. */
  collects: string;
  examples: string[];
  tags?: string[];
}

/** The agent's A2A 1.0 Agent Card: JSONRPC 1.0, streaming, the handoff extension, relay-only bearer auth. */
export function quoteAgentCard(o: CardOptions) {
  return {
    name: o.name,
    description: o.description,
    version: '1.0.0',
    provider: { organization: o.organization, url: o.origin },
    supportedInterfaces: [{ url: `${o.origin}${o.path}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [
        {
          uri: HANDOFF_EXTENSION,
          description: 'Reads the handoff envelope an on-page assistant sends, and ends with a hand-back carrying the quote reference.',
          required: false,
        },
      ],
    },
    // Only the site's handoff relay may call it, with a bearer token it holds server-side.
    securitySchemes: {
      relay: { httpAuthSecurityScheme: { scheme: 'Bearer', description: "The site's handoff relay credential. Visitors reach this agent through the relay." } },
    },
    securityRequirements: [{ schemes: { relay: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'request-quote',
        name: 'Request a quote',
        description: o.collects,
        tags: o.tags ?? ['quote', 'estimate'],
        examples: o.examples,
      },
    ],
  };
}

// ── The endpoint, as web Request → Response ─────────────────────────────────

export const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };
const MAX_BODY = 64_000;

const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

export interface EndpointOptions {
  card: ReturnType<typeof quoteAgentCard>;
  executor: QuoteExecutor;
  /** The SDK's task store: `InMemoryTaskStore` on one process; the host's store otherwise. */
  tasks: TaskStore;
  /** Whether a request carries the relay's credential. Compare to a server-side secret. */
  fromRelay(req: Request): boolean;
  /** Runs before a GetTask or SubscribeToTask: a host with a time limit fails tasks a cut-off turn left working. */
  beforeRead?(taskId: string): Promise<void>;
}

/**
 * The A2A endpoint: POST only, relay only, 64 KB at most, A2A 1.0 JSONRPC.
 * The SDK does the protocol; its stream is written out as server-sent events.
 * Serve the card separately (GET), so it stays readable without the token.
 */
export function quoteEndpoint(o: EndpointOptions): (req: Request) => Promise<Response> {
  const card = AgentCard.fromJSON(o.card);
  const transport = new JsonRpcTransportHandler(new DefaultRequestHandler(card, o.tasks, o.executor));
  return async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!o.fromRelay(req)) return rpcError(null, -32600, 'Only the relay may call this.', 403);

    const raw = await req.text();
    // In bytes, not characters: a body of multi-byte text is larger than its length says.
    if (new TextEncoder().encode(raw).length > MAX_BODY) return rpcError(null, -32600, 'Request too large.', 413);
    let body: { id?: string | number | null; method?: string; params?: { id?: string } };
    try {
      body = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, 'Body must be JSON.', 400);
    }
    if (o.beforeRead && (body.method === 'SubscribeToTask' || body.method === 'GetTask') && body.params?.id) await o.beforeRead(body.params.id);

    const ctx = defaultServerCallContextBuilder({
      extensions: (req.headers.get('a2a-extensions') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      user: new UnauthenticatedUser(),
      headers: Object.fromEntries(req.headers),
      requestedVersion: req.headers.get('a2a-version') ?? undefined,
    });
    try {
      validateVersion(ctx.requestedVersion, card, 'JSONRPC');
    } catch (err) {
      return rpcError(body.id, -32600, err instanceof Error ? err.message : 'Unsupported A2A version.');
    }

    const out = await transport.handle(body as Record<string, unknown>, ctx);
    if (typeof (out as AsyncIterable<unknown>)?.[Symbol.asyncIterator] !== 'function') return Response.json(out);

    // The SDK's stream yields whole JSON-RPC responses; each is one server-sent event.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of out as AsyncIterable<unknown>) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch (err) {
          const error = JsonRpcTransportHandler.mapToJSONRPCError(err);
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  };
}
