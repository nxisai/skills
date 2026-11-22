/**
 * example-site.ts — a `QuoteSite` adapter: the site, as the Quote Agent
 * (agent-core.ts) sees it. This is the file you write per site; agent-core.ts
 * stays unchanged.
 *
 * It answers five things:
 *
 *   1. Who the quote is from     providerAt(page), match(text)
 *   2. What a request asks for    fields(provider) — from the field spec the page's form shares
 *   3. What the model should know facts(provider), guidance, emergency
 *   4. Where it goes              submit(provider, values) — one of the sinks below
 *   5. What to fall back on       fallback(provider)
 *
 * Written for both shapes a site comes in: one business (a roofing company:
 * every page is about it, nothing to match), or a directory (many businesses,
 * each with its own page). A listings site of local contractors is the
 * directory case.
 *
 * Replace everything marked EXAMPLE.
 */
import { createHmac } from 'node:crypto';
import form from './quote-form.example.json';
import type { HandoffPage, Provider, QuoteField, QuoteSite, Submitted } from './agent-core';

// ── The businesses ──────────────────────────────────────────────────────────

export interface Business extends Provider {
  /** The page the business's quote form is on, as a path: '/' for a one-business site, '/listings/<id>.html' in a directory. */
  page: string;
  /** Its JSON-LD `@id`, as the page publishes it: the envelope's `page.entity` on its pages. */
  entity?: string;
  /** One sentence for the model: "a roofer in Boulder County, Colorado". */
  is: string;
  services?: { name: string; description?: string }[];
  serviceArea?: string;
}

// EXAMPLE: one business. A directory lists every business it takes quotes for.
const BUSINESSES: Business[] = [
  {
    id: 'ridgeline-roofing',
    name: 'Ridgeline Roofing',
    phone: '(303) 555-0142',
    page: '/',
    entity: 'https://ridgelineroofing.example/#organization',
    is: 'a family roofing company in Boulder County, Colorado',
    services: [{ name: 'Roof Replacement' }, { name: 'Roof Repair' }, { name: 'Gutters' }, { name: 'Storm Damage Inspection' }],
    serviceArea: 'Boulder, Longmont, Louisville and Lafayette',
  },
];

// ── 1. Who the quote is from ────────────────────────────────────────────────

/** The business a page is about: by its JSON-LD `@id`, then by its path. A one-business site: always that one. */
export function providerAt(page: HandoffPage | undefined, all: Business[] = BUSINESSES): Business | null {
  if (all.length === 1) return all[0];
  if (!page) return null;
  if (page.entity) {
    const byEntity = all.find((b) => b.entity === page.entity);
    if (byEntity) return byEntity;
  }
  if (!page.url) return null;
  let path: string;
  try {
    path = new URL(page.url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  return all.find((b) => b.page === path) ?? null;
}

/**
 * Words in business names that say nothing about which business: words many
 * names share, and what a job is about. EXAMPLE — list your directory's.
 */
const COMMON = new Set('the of co llc inc and roofing roof gutters plumbing electric heating cooling services home pros'.split(' '));

const words = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** A name as a visitor would type it: lower-case, "&" as "and", without "Co." or "LLC". */
const spoken = (name: string) => words(name).filter((w) => !['co', 'llc', 'inc'].includes(w)).join(' ');

/**
 * Businesses a visitor's words name, best first: the whole name, or a word of
 * it no other business shares and no job would use. A tie comes back whole,
 * for the visitor to choose. A one-business site never needs this.
 */
export function match(text: string, all: Business[] = BUSINESSES): Business[] {
  if (all.length === 1) return [];
  const said = ` ${words(text).join(' ')} `;
  const scored = all
    .map((b) => {
      const whole = said.includes(` ${spoken(b.name)} `) ? 10 : 0;
      const own = words(b.name).filter((w) => !COMMON.has(w) && said.includes(` ${w} `)).length;
      const shared = words(b.name).filter((w) => COMMON.has(w) && w.length > 3 && said.includes(` ${w} `)).length;
      return { b, score: whole + own * 2 + (whole || own ? shared : 0) };
    })
    .filter((s) => s.score > 0);
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].score;
  return scored.filter((s) => s.score === best).map((s) => s.b);
}

// ── 2. What a request asks for ──────────────────────────────────────────────

interface SpecField {
  name: string;
  label: string;
  kind: string;
  required: boolean;
  options?: string | { value: string; label: string }[];
  other?: { value: string; label: string };
}

/** A business's quote form, field by field, as the page renders it. */
export function quoteFields(b: Business): QuoteField[] {
  return (form.fields as SpecField[]).map((f) => {
    const field: QuoteField = { name: f.name, label: f.label, kind: f.kind as QuoteField['kind'], required: f.required };
    if (f.kind === 'choice') {
      const listed = f.options === 'business.services' ? (b.services ?? []).map((s) => ({ value: s.name, label: s.name })) : (f.options as { value: string; label: string }[]);
      field.options = [...listed, ...(f.other ? [f.other] : [])];
    }
    return field;
  });
}

/**
 * The JSON the page's form posts — here `Object.fromEntries(new FormData(form))`:
 * the hidden fields first, then each field in order; an empty text input is
 * sent empty, and a select left on its placeholder is not sent. Match what
 * YOUR form sends, byte for byte: the sink should not be able to tell the two apart.
 */
export function quotePayload(b: Business, values: Record<string, string>): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const h of form.hidden) payload[h.name] = h.from === 'business.name' ? b.name : '';
  for (const f of quoteFields(b)) {
    const v = values[f.name] ?? '';
    if (f.kind === 'choice' && !v) continue;
    payload[f.name] = v;
  }
  return payload;
}

// ── 3. What the model should know ───────────────────────────────────────────

function facts(b: Business): string {
  const services = (b.services ?? []).map((s) => (s.description ? `${s.name} (${s.description})` : s.name)).join('; ');
  return [
    `${b.name} is ${b.is}${services ? `, offering: ${services}` : ''}.`,
    b.serviceArea ? `They serve ${b.serviceArea}. Phone ${b.phone}.` : `Phone ${b.phone}.`,
    'A quote request goes to them; they reply to the email given.',
  ].join(' ');
}

// EXAMPLE: what can't wait for a quote, for this trade. Tested against the lower-cased text.
const EMERGENCY =
  /\b(emergenc(y|ies)|flood(ed|ing)?|burst|gas (leak|smell)|smell(s|ing)? (of )?gas|sparking|on fire|water (is )?(pouring|coming) (in|through)|ceiling (is )?(collapsing|caving)|tree (fell )?(on|through) the (roof|house))\b/;

// ── 4. Where it goes: the sinks ─────────────────────────────────────────────

export type Sink = (b: Business, values: Record<string, string>) => Promise<Submitted>;

/** `X-Nxis-Signature: t=<ts>,v1=<hex>`: HMAC-SHA256 over "<ts>.<body>", as NxisAI signs a webhook delivery. */
export function sign(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`;
}

/**
 * The form posts to a webhook (the site's own, or the user's application
 * bound with action-binding): post the same JSON there, signed so the
 * receiver can tell a server's post from a forged one. The URL is fixed
 * server-side — never taken from a request.
 *
 * What counts as accepted is the sink's answer: here `{ status: "confirmed",
 * reference }` (the listings webhook). Read YOUR sink's shape.
 */
export function webhookSink(opts: { url: () => string; secret?: string; fetch?: typeof fetch }): Sink {
  return async (b, values) => {
    const body = JSON.stringify(quotePayload(b, values));
    const res = await (opts.fetch ?? fetch)(opts.url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.secret ? { 'X-Nxis-Signature': sign(opts.secret, body) } : {}) },
      body,
    });
    const answer = (await res.json().catch(() => null)) as { status?: string; reference?: string; reason?: string } | null;
    if (!res.ok || answer?.status !== 'confirmed') return { ok: false, error: `webhook answered ${res.status}${answer?.reason ? `: ${answer.reason}` : ''}` };
    // Sent either way; a reference is passed on only when the sink gave one.
    return { ok: true, reference: typeof answer.reference === 'string' && answer.reference ? answer.reference : undefined };
  };
}

/**
 * The form's server handler saves to the site's own database (Copperline's
 * booking agent does this with `saveSubmission`): call the same function the
 * handler calls, so the office is notified the same way and the reference
 * works wherever the site looks references up.
 */
export function appSink(save: (b: Business, payload: Record<string, string>) => Promise<{ reference?: string }>): Sink {
  return async (b, values) => {
    const { reference } = await save(b, quotePayload(b, values));
    return { ok: true, reference: reference || undefined };
  };
}

/**
 * DRAFT, unverified end to end. The QuoteAction is bound server-side
 * (`nxis:targetKind` webhook or gateway, not selfPage): run it through the
 * site's MCP server with `nxis_action`, as an authenticated principal — the
 * server validates the values against the action's inputs and delivers them
 * to the binding. A selfPage action cannot be run this way; use the sink the
 * page's form posts to.
 *
 * `callTool` is an MCP client's (`@modelcontextprotocol/sdk` `Client.callTool`),
 * connected to the site's MCP endpoint with the API key, server-side.
 */
export function nxisActionSink(opts: {
  actionId: (b: Business) => string;
  callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<{ isError?: boolean; structuredContent?: unknown; content?: unknown }>;
}): Sink {
  return async (b, values) => {
    const result = await opts.callTool({ name: 'nxis_action', arguments: { id: opts.actionId(b), arguments: values } });
    if (result.isError) return { ok: false, error: 'nxis_action answered with an error' };
    // A lead reference is a bonus under LEAD_GEN; pass one on only when the result carries it.
    const found = JSON.stringify(result.structuredContent ?? result.content ?? '').match(/"(?:lead_reference|reference|confirmationId)"\s*:\s*"([^"]+)"/);
    return { ok: true, reference: found?.[1] };
  };
}

// ── The adapter ─────────────────────────────────────────────────────────────

export function exampleSite(opts: { sink: Sink; businesses?: Business[] }): QuoteSite {
  const all = opts.businesses ?? BUSINESSES;
  const business = (p: Provider) => all.find((b) => b.id === p.id)!;
  return {
    // EXAMPLE: the agent's name matches its Agent Card and the relay's label.
    agentName: 'Ridgeline Quotes',
    role: 'sends quote requests to Ridgeline Roofing',
    providerNoun: all.length === 1 ? 'business' : 'contractor',
    providerAt: (page) => providerAt(page, all),
    match: (text) => match(text, all),
    fields: (p) => quoteFields(business(p)),
    facts: (p) => facts(business(p)),
    // Site-written lines about this form's fields. The listings example's, for its form.
    guidance: ['Ask for the service and the timeline if they are not clear from what was said, and offer a phone number once — it is optional, and "no" is an answer.'],
    emergency: {
      pattern: EMERGENCY,
      examples: 'water pouring in, a ceiling sagging, a tree through the roof, a gas smell, sparking',
      values: { timeline: ['emergency'] },
      advice: 'If you smell gas, leave the house and call 911 or the gas company first.',
      noProvider: 'call a contractor who answers around the clock',
    },
    fallback: (p) => (p ? 'the quote form on their page' : 'the quote form on the site'),
    submit: (p, values) => opts.sink(business(p), values),
  };
}
