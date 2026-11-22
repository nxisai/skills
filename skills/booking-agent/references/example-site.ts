/**
 * example-site.ts — a `BookingSite` adapter: the site, as the Booking Agent
 * (agent-core.ts) sees it. This is the file you write per site; agent-core.ts
 * stays unchanged.
 *
 * It answers six things:
 *
 *   1. Who is booked, for what, where   business, services, locations
 *   2. What a booking asks for          fields — from the field spec the page's form shares
 *   3. When                              rules (zone, lead time, hours, closed days, horizon)
 *   4. What's free                       availability — one of the sources below
 *   5. Where it goes                     submit(booking, key) — one of the sinks below
 *   6. What the model should know        facts, guidance, emergency, fallback
 *
 * One business per agent. A directory with a calendar per business runs one
 * agent per business, or sends visitors to lead-funnel-reservation.
 *
 * Replace everything marked EXAMPLE.
 */
import { createHmac, randomInt } from 'node:crypto';
import form from './booking-form.example.json';
import calendar from './availability.example.json';
import {
  addDays,
  wallClock,
  zonedInstant,
  type Availability,
  type Booked,
  type Booking,
  type BookingField,
  type BookingLocation,
  type BookingRules,
  type BookingService,
  type BookingSite,
  type Slot,
  type SlotQuery,
  type Weekday,
} from './agent-core';

// ── 1. Who is booked, for what, where ───────────────────────────────────────

// EXAMPLE: one business, from the site's own content.
export const BUSINESS = { name: 'Northside Plumbing', phone: '(773) 555-0142' };

export const SERVICES: BookingService[] = [
  { id: 'drain-cleaning', name: 'Drain cleaning', description: 'a slow or blocked sink, tub or floor drain' },
  { id: 'water-heater', name: 'Water heater repair', description: 'no hot water, a leaking or noisy tank' },
  { id: 'boiler-service', name: 'Boiler service', description: 'annual service or a radiator system that will not heat' },
];

/** EXAMPLE: one place — the crew comes to the visitor — so nothing to ask. A salon with branches lists them. */
export const LOCATIONS: BookingLocation[] = [];

// ── 2. What a booking asks for ──────────────────────────────────────────────

/** The contact fields, from the spec the page's form shares. */
export const FIELDS: BookingField[] = form.fields as BookingField[];

/**
 * The JSON the page's form posts: the service, the location, the slot, then
 * each contact field in order, an empty optional one sent as "". Match what
 * YOUR form sends, byte for byte: the sink should not be able to tell the two apart.
 */
export function bookingPayload(b: Booking, timeZone: string): Record<string, string> {
  const k = form.posted;
  const payload: Record<string, string> = { [k.service]: b.service.id };
  if (b.location) payload[k.location] = b.location.id;
  Object.assign(payload, { [k.slot]: b.slot.id, [k.start]: b.slot.start, [k.end]: b.slot.end, [k.timeZone]: timeZone });
  for (const f of FIELDS) payload[f.name] = b.values[f.name] ?? '';
  return payload;
}

// ── 3. When ─────────────────────────────────────────────────────────────────

// EXAMPLE: the business's zone and rules. Every slot offered obeys them, whatever the source returns.
export const RULES: BookingRules = {
  timeZone: 'America/Chicago',
  zoneName: 'Chicago time',
  leadMinutes: 120,
  horizonDays: 30,
  hours: {
    mon: [['08:00', '17:00']],
    tue: [['08:00', '17:00']],
    wed: [['08:00', '17:00']],
    thu: [['08:00', '17:00']],
    fri: [['08:00', '17:00']],
    sat: [['09:00', '13:00']],
  },
  closed: ['2026-11-26', '2026-12-25'],
  offer: 3,
};

// ── 4. What's free: the sources ─────────────────────────────────────────────

/** availability.example.json's shape. */
export interface CalendarSpec {
  timeZone: string;
  windowMinutes: number;
  windows: Partial<Record<Weekday, string[]>>;
  booked: string[];
}

export interface MemoryCalendar extends Availability {
  /** Book a slot, if it is still free: true when this call took it. */
  take(slotId: string): boolean;
  /** Mark a slot taken by someone else. For tests and demos. */
  block(slotId: string): void;
}

/**
 * An in-memory calendar from availability.example.json: arrival windows per
 * weekday in the business's zone, one crew. A slot's id is its local start,
 * "2026-11-10T08:00", so one window booked for any service is gone for all.
 * For trying the agent; a site's real source is its own calendar.
 */
export function memoryAvailability(spec: CalendarSpec = calendar as CalendarSpec): MemoryCalendar {
  const booked = new Set<string>(spec.booked);
  const windows = spec.windows;
  return {
    async slots(q: SlotQuery): Promise<Slot[]> {
      const from = Date.parse(q.from);
      const to = Date.parse(q.to);
      const out: Slot[] = [];
      for (let date = wallClock(from, spec.timeZone).date; zonedInstant(date, '00:00', spec.timeZone) < to && out.length < q.limit; date = addDays(date, 1)) {
        const weekday = wallClock(zonedInstant(date, '12:00', spec.timeZone), spec.timeZone).weekday;
        for (const time of windows[weekday] ?? []) {
          const start = zonedInstant(date, time, spec.timeZone);
          const id = `${date}T${time}`;
          if (start < from || start >= to || booked.has(id)) continue;
          out.push({ id, start: new Date(start).toISOString(), end: new Date(start + spec.windowMinutes * 60_000).toISOString() });
          if (out.length >= q.limit) break;
        }
      }
      return out;
    },
    take(id) {
      if (booked.has(id)) return false;
      booked.add(id);
      return true;
    },
    block: (id) => void booked.add(id),
  };
}

/**
 * The site's own availability endpoint: `GET <url>?service=&location=&from=&to=&limit=`
 * answering `{ "slots": [{ "id", "start", "end", "location"? }] }`. The URL is
 * fixed server-side. Anything malformed is dropped: an unreadable answer
 * offers nothing rather than something made up.
 */
export function httpAvailability(opts: { url: () => string; headers?: () => Record<string, string>; fetch?: typeof fetch }): Availability {
  return {
    async slots(q) {
      const url = new URL(opts.url());
      for (const [k, v] of Object.entries({ service: q.service, location: q.location, from: q.from, to: q.to, limit: String(q.limit) })) if (v) url.searchParams.set(k, v);
      const res = await (opts.fetch ?? fetch)(url, { headers: { Accept: 'application/json', ...opts.headers?.() } });
      if (!res.ok) throw new Error(`availability answered ${res.status}`);
      const body = (await res.json().catch(() => null)) as { slots?: unknown } | null;
      return (Array.isArray(body?.slots) ? body.slots : [])
        .filter((s): s is Slot => !!s && typeof s === 'object' && typeof (s as Slot).id === 'string' && typeof (s as Slot).start === 'string' && typeof (s as Slot).end === 'string')
        .map((s) => ({ id: s.id, start: s.start, end: s.end, ...(typeof s.location === 'string' ? { location: s.location } : {}) }));
    },
  };
}

// ── 5. Where it goes: the sinks ─────────────────────────────────────────────

export type Sink = (b: Booking, idempotencyKey: string) => Promise<Booked>;

/** A booking reference: a prefix and eight characters without look-alikes, from a cryptographic source. */
export function newReference(prefix = 'NB'): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return `${prefix}-${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
}

/**
 * Books into the in-memory calendar: takes the slot if it is still free (a
 * conflict if not), and answers a repeated idempotency key with the same
 * reference rather than booking again.
 */
export function memorySink(cal: MemoryCalendar, onBooked?: (b: Booking, reference: string) => void): Sink {
  const byKey = new Map<string, string>();
  return async (b, key) => {
    const seen = byKey.get(key);
    if (seen) return { ok: true, reference: seen };
    if (!cal.take(b.slot.id)) return { ok: false, conflict: true };
    const reference = newReference();
    byKey.set(key, reference);
    onBooked?.(b, reference);
    return { ok: true, reference };
  };
}

/** `X-Nxis-Signature: t=<ts>,v1=<hex>`: HMAC-SHA256 over "<ts>.<body>", as NxisAI signs a webhook delivery. */
export function sign(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`;
}

/**
 * The form posts to a webhook (the site's own, or the user's application bound
 * with action-binding): post the same JSON there, signed, with an
 * `Idempotency-Key` the receiver can dedupe on. The URL is fixed server-side —
 * never taken from a request.
 *
 * What the sink answers decides: `{ status: "confirmed", reference }` is booked;
 * `409 { status: "conflict", alternatives? }` is a slot taken since it was
 * checked (lead-funnel-reservation's shape); anything else failed. Read YOUR
 * sink's shape.
 */
export function webhookSink(opts: { url: () => string; secret?: string; timeZone: string; fetch?: typeof fetch }): Sink {
  return async (b, key) => {
    const body = JSON.stringify(bookingPayload(b, opts.timeZone));
    const res = await (opts.fetch ?? fetch)(opts.url(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(opts.secret ? { 'X-Nxis-Signature': sign(opts.secret, body) } : {}) },
      body,
    });
    const answer = (await res.json().catch(() => null)) as { status?: string; reference?: string; reason?: string; alternatives?: Slot[] } | null;
    if (res.status === 409 || answer?.status === 'conflict') {
      return { ok: false, conflict: true, alternatives: Array.isArray(answer?.alternatives) ? answer.alternatives : undefined };
    }
    if (!res.ok || answer?.status !== 'confirmed') return { ok: false, error: `webhook answered ${res.status}${answer?.reason ? `: ${answer.reason}` : ''}` };
    // Booked either way; a reference is passed on only when the sink gave one.
    return { ok: true, reference: typeof answer.reference === 'string' && answer.reference ? answer.reference : undefined };
  };
}

/**
 * The form's server handler saves to the site's own database (Copperline's
 * booking agent calls the /book form's `saveSubmission`): call the same
 * function, so the office is notified the same way and the reference works
 * wherever the site looks references up. `save` must refuse a slot that is
 * no longer free (return `conflict`) and dedupe on the key.
 */
export function appSink(save: (payload: Record<string, string>, key: string) => Promise<{ reference?: string } | { conflict: true }>, timeZone: string): Sink {
  return async (b, key) => {
    const r = await save(bookingPayload(b, timeZone), key);
    if ('conflict' in r) return { ok: false, conflict: true };
    return { ok: true, reference: r.reference || undefined };
  };
}

/**
 * DRAFT, unverified end to end. The ScheduleAction or ReserveAction is bound
 * server-side (`nxis:targetKind` webhook or gateway, not selfPage): run it
 * through the site's MCP server with `nxis_action`, as an authenticated
 * principal — what lead-funnel-reservation does from outside the site.
 * `callTool` is an MCP client's (`Client.callTool`), with the API key, server-side.
 */
export function nxisActionSink(opts: {
  actionId: string;
  timeZone: string;
  callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<{ isError?: boolean; structuredContent?: unknown; content?: unknown }>;
}): Sink {
  return async (b) => {
    const result = await opts.callTool({ name: 'nxis_action', arguments: { id: opts.actionId, arguments: bookingPayload(b, opts.timeZone) } });
    const text = JSON.stringify(result.structuredContent ?? result.content ?? '');
    if (/"status"\s*:\s*"conflict"|\b409\b/.test(text)) return { ok: false, conflict: true };
    if (result.isError) return { ok: false, error: 'nxis_action answered with an error' };
    const found = text.match(/"(?:reservationId|reference|confirmationId)"\s*:\s*"([^"]+)"/);
    return { ok: true, reference: found?.[1] };
  };
}

// ── 6. What the model should know ───────────────────────────────────────────

// EXAMPLE: what can't wait for a booking, for this trade. Tested against the lower-cased text.
const EMERGENCY =
  /\b(emergenc(y|ies)|flood(ed|ing)?|burst (pipe|main)|gas (leak|smell)|smell(s|ing)? (of )?gas|sewage (is )?(coming|backing) up|water (is )?(pouring|gushing|coming) (in|through|out))\b/;

// ── The adapter ─────────────────────────────────────────────────────────────

export function exampleSite(opts: { sink: Sink; availability: Availability; rules?: BookingRules; locations?: BookingLocation[] }): BookingSite {
  return {
    // EXAMPLE: the agent's name matches its Agent Card and the relay's label.
    agentName: 'Northside Booking',
    role: `books service visits for ${BUSINESS.name}`,
    business: BUSINESS,
    services: SERVICES,
    locations: opts.locations ?? LOCATIONS,
    fields: FIELDS,
    rules: opts.rules ?? RULES,
    locale: 'en-US',
    facts: `${BUSINESS.name} is a plumbing and heating company on Chicago's North Side. Services: ${SERVICES.map((s) => `${s.name} (${s.description})`).join('; ')}. A technician arrives within the booked two-hour window. Phone ${BUSINESS.phone}.`,
    guidance: [
      'Offer an email once — it is optional, and "no" is an answer.',
      "Put what's wrong in notes in the visitor's own words, if they said; do not embellish.",
    ],
    emergency: {
      pattern: EMERGENCY,
      examples: 'active flooding, a burst pipe, sewage backing up, a gas smell',
      advice: 'If you smell gas, leave the building and call 911 or the gas company first.',
    },
    fallback: 'the booking form at /book',
    availability: opts.availability,
    submit: (b, key) => opts.sink(b, key),
  };
}
