/**
 * hosts/bookings.ts — availability and holds for a booking receiver. The
 * business's own calendar answers what is open and keeps a short hold while
 * the visitor confirms; NxisAI only reads what this answers.
 *
 * receiver.ts calls it for every booking (`?action=booking`, `schedule` or
 * `reserve` on the connection's address, or a body that names a window or a
 * hold). The hours, the capacity and the hold length are `calendar` in
 * submissions.ts; the store comes from the host file.
 *
 * A check (`"nxis:mode": "check"`) answers
 *
 *   { "available": true|false,
 *     "windows": [{ "start": "<ISO>", "end": "<ISO>", "open": <seats left> }],
 *     "hold": { "token": "…", "expires_at": "<ISO>" },          only for one window
 *     "alternatives": [<windows>], "reason": "…" }               when it isn't open
 *
 * - No window named: the next open windows. `date` alone: that day's windows,
 *   full ones too (`open: 0`).
 * - One window (`start`, or `date` + `window`): that window. When it has a
 *   seat, a hold takes it for `holdSeconds`, and the answer carries the hold.
 *   A check that sends back a live `hold_token` for the same window gets the
 *   same hold again, not a second one. When it is full, past or too far ahead:
 *   `available: false`, the reason, and the next open windows.
 * - A check never commits: nothing is delivered and nothing is booked. A hold
 *   only reserves a seat until it expires.
 *
 * A commit
 *
 * - with `hold_token`: books the held seat while the hold is live. An expired
 *   hold is refused with 409 `code: "hold_expired"`, a token this calendar
 *   didn't issue (or that names another window than the body) with 409
 *   `code: "hold_unknown"`, each with the open windows to choose from instead.
 * - without one: books a free seat when the window has one, or answers 409
 *   `code: "taken"` with the next open windows.
 * - When deliver() doesn't confirm (a rejection, a conflict, a throw), the
 *   seat is given back, and a held seat goes back to being held, so a
 *   corrected call with the same hold still goes through.
 *
 * Seats are store keys (`nxis-slot:<window start ms>:<seat>`), taken with an
 * only-if-new write and changed with an only-if-unchanged one, so two
 * visitors can't both get the last seat. memorySlotStore() is right for one
 * long-running process; each host file says which shared store to use on its
 * host.
 */
import type { Availability, Delivery, Submission } from './receiver';

// ── The store ────────────────────────────────────────────────────────────────

/** What a seat holds: a visitor's hold until `expires` (unix ms), or a booking. */
export type Seat = { kind: 'hold'; token: string; expires: number } | { kind: 'booked'; key: string };

/**
 * Where seats live. Every write is conditional, which is what makes holds and
 * the last seat safe across instances:
 *
 * - `create` writes only if the key is absent, and returns the new version, or
 *   null when the key exists (Netlify Blobs `onlyIfNew`, Redis `SET NX`, D1
 *   `INSERT … ON CONFLICT DO NOTHING`)
 * - `replace` writes only if the key is still at `version`, and returns the
 *   new one, or null (Blobs `onlyIfMatch` with the etag, a Redis script that
 *   compares a version field, D1 `UPDATE … WHERE version = ?`)
 * - `delete` removes the key, only at `version` where the store can
 *
 * `ttlSeconds` lets a store that can expire keys drop dead ones; a store that
 * can't may keep them, since an expired hold counts as free either way. A
 * Durable Object that owns the whole calendar runs one request at a time, so
 * a Map in its storage meets all of this.
 */
export interface SlotStore {
  get(key: string): Promise<{ value: Seat; version: string } | null>;
  create(key: string, value: Seat, ttlSeconds: number): Promise<string | null>;
  replace(key: string, value: Seat, version: string, ttlSeconds: number): Promise<string | null>;
  delete(key: string, version: string): Promise<void>;
}

export function memorySlotStore(): SlotStore {
  const items = new Map<string, { value: Seat; version: string; expires: number }>();
  let counter = 0;
  const live = (key: string) => {
    const item = items.get(key);
    if (item && item.expires <= Date.now()) items.delete(key);
    return items.get(key) ?? null;
  };
  const write = (key: string, value: Seat, ttl: number) => {
    const version = String(++counter);
    items.set(key, { value, version, expires: Date.now() + ttl * 1000 });
    return version;
  };
  return {
    async get(key) {
      const item = live(key);
      return item ? { value: item.value, version: item.version } : null;
    },
    async create(key, value, ttl) {
      return live(key) ? null : write(key, value, ttl);
    },
    async replace(key, value, version, ttl) {
      return live(key)?.version === version ? write(key, value, ttl) : null;
    },
    async delete(key, version) {
      if (live(key)?.version === version) items.delete(key);
    },
  };
}

// ── The calendar ─────────────────────────────────────────────────────────────

/** A window the business offers: start and end as ISO instants with an offset. */
export interface WindowSpec {
  start: string;
  end: string;
  /** A name a visitor may use for it ("morning"). */
  name?: string;
}

/** A window as a check answers it. */
export interface Window extends WindowSpec {
  /** Seats still free. */
  open: number;
}

export interface Hold {
  token: string;
  expires_at: string;
}

export interface CalendarOptions {
  /** The windows offered on a local date (YYYY-MM-DD), earliest first. weeklyWindows() builds one from opening hours. */
  windowsOn: (date: string) => WindowSpec[];
  /** The business's time zone, an IANA name: dates in requests are local to it. */
  timeZone: string;
  /** Bookings each window takes at once (crews, chairs, tables). Default 1. */
  capacity?: number;
  /** How long a check's hold keeps a seat. Default 300; 0 turns holds off. */
  holdSeconds?: number;
  /** How far ahead the calendar is open. Default 30. */
  horizonDays?: number;
  /** The least notice a window needs, in minutes. Default 60. */
  leadMinutes?: number;
  /** How many windows a check lists when it names none, and as alternatives. Default 5 and 3. */
  listLimit?: number;
  alternativesLimit?: number;
}

export interface BookingCalendar {
  /** Whether this call is a booking this calendar answers. */
  handles(submission: Submission): boolean;
  check(submission: Submission): Promise<Availability>;
  /** Takes the seat, then calls deliver(); gives the seat back when deliver() doesn't confirm. */
  commit(submission: Submission, deliver: (submission: Submission) => Promise<Delivery>): Promise<Delivery>;
}

const BOOKING_ACTIONS = new Set(['booking', 'schedule', 'reserve']);
const START_KEYS = ['start', 'slot', 'startDate', 'start_time', 'startTime'];
const DATE_KEYS = ['date', 'preferredDate', 'preferred_date'];
const WINDOW_KEYS = ['window', 'time', 'arrivalWindow', 'arrival_window', 'timeWindow', 'time_window'];

const text = (args: Record<string, unknown>, keys: string[]): { value: string; key: string } => {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return { value: v.trim(), key };
  }
  return { value: '', key: keys[0] };
};

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** The offset of a time zone at an instant, in minutes east of UTC. */
function offsetMinutes(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((wall - at) / 60_000);
}

/** A wall time on a local date, as an ISO instant with the zone's offset on that day. */
export function zonedTime(date: string, hhmm: string, timeZone: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const wall = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000;
  let offset = offsetMinutes(wall, timeZone);
  offset = offsetMinutes(wall - offset * 60_000, timeZone);
  const a = Math.abs(offset);
  return `${date}T${hhmm}:00${offset < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The local date (YYYY-MM-DD) of an instant. */
export function localDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Weekday names, Sunday first, as weeklyWindows() takes them. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Windows from weekly hours: `{ mon: [['08:00', '12:00', 'morning'], …], … }`,
 * local to `timeZone`. `closed` lists dates with none (holidays).
 */
export function weeklyWindows(opts: {
  timeZone: string;
  week: Partial<Record<Weekday, [start: string, end: string, name?: string][]>>;
  closed?: string[];
}): (date: string) => WindowSpec[] {
  const closed = new Set(opts.closed ?? []);
  return (date) => {
    if (closed.has(date)) return [];
    const day = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
    return (opts.week[day] ?? []).map(([start, end, name]) => ({
      start: zonedTime(date, start, opts.timeZone),
      end: zonedTime(date, end, opts.timeZone),
      ...(name ? { name } : {}),
    }));
  };
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** `h1.<window start ms>.<seat>.<expires, unix s>.<random>`: names its seat; only the store's copy makes it valid. */
function newToken(startMs: number, seat: number, expires: number): string {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `h1.${startMs}.${seat}.${Math.floor(expires / 1000)}.${nonce}`;
}

function parseToken(token: string): { startMs: number; seat: number; expires: number } | null {
  const m = /^h1\.(\d{1,15})\.(\d{1,4})\.(\d{1,12})\.[0-9a-f]{32}$/.exec(token);
  return m ? { startMs: Number(m[1]), seat: Number(m[2]), expires: Number(m[3]) * 1000 } : null;
}

type Request =
  | { kind: 'next' }
  | { kind: 'day'; date: string }
  | { kind: 'one'; window: WindowSpec }
  | { kind: 'none'; reason: string; after: number }
  | { kind: 'invalid'; errors: Record<string, string> };

export function bookingCalendar(opts: CalendarOptions & { store: SlotStore; now?: () => number }): BookingCalendar {
  const { store, timeZone, windowsOn } = opts;
  const capacity = Math.max(1, opts.capacity ?? 1);
  const holdMs = Math.max(0, opts.holdSeconds ?? 300) * 1000;
  const horizonMs = (opts.horizonDays ?? 30) * DAY_MS;
  const leadMs = (opts.leadMinutes ?? 60) * 60_000;
  const listLimit = opts.listLimit ?? 5;
  const alternativesLimit = opts.alternativesLimit ?? 3;
  const now = opts.now ?? (() => Date.now());

  const seatKey = (startMs: number, seat: number) => `nxis-slot:${startMs}:${seat}`;
  const startOf = (w: WindowSpec) => Date.parse(w.start);
  const bookedTtl = (w: WindowSpec) => Math.max(60, Math.ceil((Date.parse(w.end) + DAY_MS - now()) / 1000));
  const holdTtl = () => Math.ceil(holdMs / 1000) + 60;
  /** Just before a local date begins: windows that day start after it. */
  const midnight = (date: string) => Date.parse(zonedTime(date, '00:00', timeZone)) - 1;
  const free = (seat: { value: Seat } | null, at: number) => !seat || (seat.value.kind === 'hold' && seat.value.expires <= at);

  /** Offered at all: not past the lead time, not beyond the horizon. */
  const bookable = (w: WindowSpec, at: number) => startOf(w) >= at + leadMs && startOf(w) <= at + horizonMs;

  function windowAt(startMs: number): WindowSpec | null {
    return windowsOn(localDate(startMs, timeZone)).find((w) => startOf(w) === startMs) ?? null;
  }

  async function openSeats(w: WindowSpec, at: number): Promise<number> {
    const seats = await Promise.all(Array.from({ length: capacity }, (_, i) => store.get(seatKey(startOf(w), i + 1))));
    return seats.filter((s) => free(s, at)).length;
  }

  const withOpen = async (w: WindowSpec, at: number): Promise<Window> => ({ ...w, open: await openSeats(w, at) });

  /** Open windows starting after `afterMs`, earliest first. */
  async function nextOpen(afterMs: number, limit: number, at: number): Promise<Window[]> {
    const out: Window[] = [];
    const last = localDate(at + horizonMs, timeZone);
    for (let date = localDate(Math.max(afterMs, at), timeZone); date <= last && out.length < limit; date = addDays(date, 1)) {
      for (const w of windowsOn(date)) {
        if (out.length >= limit) break;
        if (startOf(w) <= afterMs || !bookable(w, at)) continue;
        const open = await openSeats(w, at);
        if (open > 0) out.push({ ...w, open });
      }
    }
    return out;
  }

  function requested(args: Record<string, unknown>, at: number): Request {
    const start = text(args, START_KEYS);
    if (start.value) {
      const ms = Date.parse(start.value);
      if (Number.isNaN(ms) || !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start.value)) {
        return { kind: 'invalid', errors: { [start.key]: "Give the window's start as an ISO date and time, as a check lists it." } };
      }
      const w = windowAt(ms);
      return w ? { kind: 'one', window: w } : { kind: 'none', reason: 'That time is not one of the windows offered.', after: ms };
    }
    const date = text(args, DATE_KEYS);
    if (!date.value) return { kind: 'next' };
    const day = date.value.slice(0, 10);
    if (!isDate(day)) return { kind: 'invalid', errors: { [date.key]: 'Give the date as YYYY-MM-DD.' } };
    const named = text(args, WINDOW_KEYS);
    if (!named.value) return { kind: 'day', date: day };
    const v = named.value.toLowerCase();
    const w = windowsOn(day).find((x) => x.name?.toLowerCase() === v || x.start.slice(11, 16) === v.slice(0, 5));
    return w
      ? { kind: 'one', window: w }
      : { kind: 'none', reason: 'No window by that name or start time is offered on that day.', after: midnight(day) };
  }

  /** Why a window can't be booked now, or null when it can. */
  function closedReason(w: WindowSpec, at: number): string | null {
    if (startOf(w) < at + leadMs) return 'That window has started, or is too soon to book.';
    if (startOf(w) > at + horizonMs) return 'That date is further ahead than the calendar is open.';
    return null;
  }

  /** The seat a token names, when it is still that hold. */
  async function heldSeat(token: string) {
    const t = parseToken(token);
    if (!t || t.seat < 1 || t.seat > capacity) return null;
    const key = seatKey(t.startMs, t.seat);
    const seat = await store.get(key);
    if (!seat || seat.value.kind !== 'hold' || seat.value.token !== token) return null;
    return { key, seat, startMs: t.startMs, seatNo: t.seat };
  }

  /** Takes a free seat for `value`: a new key, or one whose hold has expired. */
  async function takeSeat(w: WindowSpec, value: Seat, ttl: number, at: number) {
    for (let i = 1; i <= capacity; i++) {
      const key = seatKey(startOf(w), i);
      const seat = await store.get(key);
      if (!free(seat, at)) continue;
      const version = seat ? await store.replace(key, value, seat.version, ttl) : await store.create(key, value, ttl);
      if (version) return { key, version, previous: null as { value: Seat; version: string } | null };
    }
    return null;
  }

  const unavailable = async (reason: string, after: number, at: number): Promise<Availability> => {
    const alternatives = await nextOpen(after, alternativesLimit, at);
    return { available: false, reason, windows: alternatives, alternatives };
  };

  return {
    handles({ action, args }) {
      if (action) return BOOKING_ACTIONS.has(action.toLowerCase());
      return typeof args.hold_token === 'string' || !!text(args, START_KEYS).value || !!text(args, DATE_KEYS).value;
    },

    async check({ args }) {
      const at = now();
      const r = requested(args, at);
      if (r.kind === 'invalid') return { ...(await unavailable('The requested window could not be read.', at, at)), errors: r.errors };
      if (r.kind === 'none') return unavailable(r.reason, r.after, at);
      if (r.kind === 'next') {
        const windows = await nextOpen(at, listLimit, at);
        return { available: windows.length > 0, windows, ...(windows.length ? {} : { reason: 'Nothing is open in the calendar.' }) };
      }
      if (r.kind === 'day') {
        const windows = await Promise.all(windowsOn(r.date).filter((w) => bookable(w, at)).map((w) => withOpen(w, at)));
        if (windows.some((w) => w.open > 0)) return { available: true, windows };
        const alternatives = await nextOpen(midnight(addDays(r.date, 1)), alternativesLimit, at);
        return { available: false, reason: 'Nothing is open that day.', windows, alternatives };
      }

      const w = r.window;
      const closed = closedReason(w, at);
      if (closed) return unavailable(closed, startOf(w), at);

      // The same visitor checking again keeps the hold they have.
      const token = typeof args.hold_token === 'string' ? args.hold_token : '';
      const mine = token ? await heldSeat(token) : null;
      if (mine && mine.startMs === startOf(w) && mine.seat.value.kind === 'hold' && mine.seat.value.expires > at) {
        return { available: true, windows: [await withOpen(w, at)], hold: { token, expires_at: new Date(mine.seat.value.expires).toISOString() } };
      }

      if (holdMs === 0) {
        const open = await openSeats(w, at);
        return open > 0 ? { available: true, windows: [{ ...w, open }] } : unavailable('That window is fully booked.', startOf(w), at);
      }
      const expires = at + holdMs;
      // The token names the seat it takes, so try each seat with its own.
      for (let i = 1; i <= capacity; i++) {
        const key = seatKey(startOf(w), i);
        const seat = await store.get(key);
        if (!free(seat, at)) continue;
        const holdToken = newToken(startOf(w), i, expires);
        const value: Seat = { kind: 'hold', token: holdToken, expires };
        const version = seat ? await store.replace(key, value, seat.version, holdTtl()) : await store.create(key, value, holdTtl());
        if (version) return { available: true, windows: [await withOpen(w, at)], hold: { token: holdToken, expires_at: new Date(expires).toISOString() } };
      }
      return unavailable('That window is fully booked.', startOf(w), at);
    },

    async commit(submission, deliver) {
      const { args, idempotencyKey } = submission;
      const at = now();
      const booked: Seat = { kind: 'booked', key: idempotencyKey };
      const token = typeof args.hold_token === 'string' ? args.hold_token.trim() : '';
      let window: WindowSpec;
      let taken: { key: string; version: string; previous: { value: Seat; version: string } | null };

      if (token) {
        const t = parseToken(token);
        const w = t ? windowAt(t.startMs) : null;
        const r = requested(args, at);
        const refuse = async (code: string, reason: string): Promise<Delivery> => {
          const open = w && !closedReason(w, at) ? await withOpen(w, at) : null;
          const after = await nextOpen(w ? startOf(w) : at, alternativesLimit, at);
          return { conflict: reason, code, alternatives: open && open.open > 0 ? [open, ...after].slice(0, alternativesLimit) : after };
        };
        if (!t || !w || (r.kind === 'one' && startOf(r.window) !== t.startMs)) {
          return refuse('hold_unknown', 'That hold is not one this calendar issued for that window. Check the window again.');
        }
        if (t.expires <= at) return refuse('hold_expired', 'The hold on that window has expired. Check the window again.');
        const held = await heldSeat(token);
        if (!held || held.seat.value.kind !== 'hold') return refuse('hold_unknown', 'That hold is not one this calendar issued for that window. Check the window again.');
        if (held.seat.value.expires <= at) return refuse('hold_expired', 'The hold on that window has expired. Check the window again.');
        const version = await store.replace(held.key, booked, held.seat.version, bookedTtl(w));
        if (!version) return refuse('hold_expired', 'The hold on that window has expired. Check the window again.');
        window = w;
        taken = { key: held.key, version, previous: held.seat };
      } else {
        const r = requested(args, at);
        if (r.kind === 'invalid') return { rejected: 'The requested window could not be read.', errors: r.errors };
        if (r.kind === 'next' || r.kind === 'day') {
          return { rejected: 'Pick one window.', errors: { start: "The window's start, as a check lists it." } };
        }
        if (r.kind === 'none') return { conflict: r.reason, code: 'taken', alternatives: await nextOpen(r.after, alternativesLimit, at) };
        const closed = closedReason(r.window, at);
        if (closed) return { conflict: closed, code: 'taken', alternatives: await nextOpen(startOf(r.window), alternativesLimit, at) };
        const seat = await takeSeat(r.window, booked, bookedTtl(r.window), at);
        if (!seat) {
          return { conflict: 'That window is fully booked.', code: 'taken', alternatives: await nextOpen(startOf(r.window), alternativesLimit, at) };
        }
        window = r.window;
        taken = seat;
      }

      // Give the seat back (and a held seat its hold) when the booking didn't go through.
      const giveBack = async () => {
        const prev = taken.previous;
        if (prev && prev.value.kind === 'hold' && prev.value.expires > now()) {
          await store.replace(taken.key, prev.value, taken.version, holdTtl());
        } else {
          await store.delete(taken.key, taken.version);
        }
      };
      let result: Delivery;
      try {
        result = await deliver({ ...submission, booking: { start: window.start, end: window.end, held: !!token } });
      } catch (err) {
        await giveBack().catch(() => {});
        throw err;
      }
      if (!('reference' in result)) {
        await giveBack().catch(() => {});
        return result;
      }
      return { reference: result.reference, extra: { start: window.start, end: window.end, ...result.extra } };
    },
  };
}
