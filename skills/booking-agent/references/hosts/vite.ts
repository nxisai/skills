/**
 * hosts/vite.ts — the Booking Agent on a Node server: a Vite plugin for the dev
 * and preview servers. The same handler serves as Express middleware.
 *
 * Status: DRAFT. The same file as the quote agent's vite profile, which is
 * verified on a Vite dev server behind a tunnel; this one is exercised in
 * process by hosts.test.ts (the relay, this handler, the example calendar and
 * a watched sink) but has not run on a Vite server. A production Node
 * deployment is unconfirmed: tasks and progress live in this process's
 * memory, which is right for one long-lived process and wrong for several.
 *
 *   POST /a2a/booking                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/booking/agent-card.json    its Agent Card
 *   GET  /.well-known/agent-card.json  the same card, where A2A clients look first —
 *                                      only if no other agent on the site claims it
 *
 * Host answers:
 * - Server code: a plugin's `configureServer` / `configurePreviewServer` middleware.
 *   `vite build` alone produces a static site with no agent: production needs a Node server.
 * - Where tasks live: the SDK's InMemoryTaskStore and agent-core's memoryProgress().
 *   More than one process: a shared store for both (Redis, a table) — see hosts/netlify.ts.
 * - Secrets: the process environment, loaded with `loadEnv(mode, cwd, '')` in
 *   vite.config.ts. Never a VITE_-prefixed variable: those are compiled into the page.
 * - Relay credential: the relay and this agent in one process share a fresh
 *   random token per start (RELAY_TOKEN below); the relay's target uses it.
 *   On separate processes, set BOOKING_AGENT_TOKEN on both.
 * - Response time: no limit. A tunnel may cut idle streams; the harness resumes.
 * - Availability: BOOKING_AVAILABILITY_URL, the site's own free-slot endpoint
 *   (example-site.ts, httpAvailability). Unset, the agent is unavailable and the
 *   form takes bookings — unless BOOKING_EXAMPLE_CALENDAR=true, which uses the
 *   in-memory example calendar: for trying it out, never for a live site.
 *
 * In vite.config.ts:
 *
 *   const env = loadEnv(mode, process.cwd(), '');
 *   plugins: [ ..., bookingAgentPlugin(env), handoffPlugin(env) ]
 *
 * and in the relay adapter (agent-handoff), the target:
 *
 *   { name: 'booking', kind: 'agent', label: 'Northside Booking', description: '…',
 *     endpoint: '/a2a/booking', credential: () => ({ Authorization: `Bearer ${RELAY_TOKEN}` }),
 *     transcript: false, push: false, availability: bookingAvailability }
 *
 * The relay may call `bookingA2A` in-process instead of over the network
 * (a `fetch` that routes '/a2a/booking' to it); the token is checked all the same.
 */
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import { BookingExecutor, claudeModel, bookingAgentCard, bookingEndpoint, type MessagesClient, type BookingModel, type BookingSite } from '../agent-core';
import { RULES, exampleSite, httpAvailability, memoryAvailability, webhookSink } from '../example-site';

const PATH = '/a2a/booking';
const CARD = `${PATH}/agent-card.json`;
const WELL_KNOWN = '/.well-known/agent-card.json';
/** A current Sonnet. Override with BOOKING_MODEL. */
export const DEFAULT_BOOKING_MODEL = 'claude-sonnet-5-5';

/** What the relay proves itself with. One process: fresh each start. Separate processes: BOOKING_AGENT_TOKEN on both. */
export const RELAY_TOKEN = process.env.BOOKING_AGENT_TOKEN || randomUUID();
const fromRelay = (req: Request) => req.headers.get('authorization') === `Bearer ${RELAY_TOKEN}`;

/** Where the form's sink is: this server's own /api/book unless BOOKING_SINK_URL says. Never an address a request supplied. */
let sinkUrl = () => 'http://localhost:5173/api/book';
let secret: string | undefined;

/** The model and the site, with or without a calendar. Set by the plugin; tests set their own with `useBookingAgent`. */
const state: { model: BookingModel | null; site: BookingSite | null } = { model: null, site: null };

/** Whether it can take a handoff now: only with a model and a calendar to read. The relay target's `availability`. */
export const bookingAvailability = async () => ({ available: state.model !== null && state.site !== null });

/** EXAMPLE: the card's words. The name matches BookingSite.agentName and the relay's label. */
const card = (origin: string) =>
  bookingAgentCard({
    origin,
    path: PATH,
    name: 'Northside Booking',
    description:
      'Books a plumbing or heating visit in conversation — asks one question at a time, offers only the free times on the calendar, confirms the details with the visitor, books it with Northside Plumbing, and returns a booking reference.',
    organization: 'Northside Plumbing',
    collects:
      "Collects the service, a day and one of the free arrival windows (in the business's time zone), and the visitor's name, phone, address and optional email; confirms them with the visitor; books it as the site's booking form would; and returns a booking reference.",
    examples: ['Can someone look at my water heater tomorrow?', 'Book a drain cleaning for next week'],
    tags: ['booking', 'appointment', 'schedule', 'home services'],
  });

let handle: ((req: Request) => Promise<Response>) | null = null;

/** For tests: a scripted model, or none, and a site whose sink they can watch. Starts afresh. */
export function useBookingAgent(opts: { model: BookingModel | null; site?: BookingSite | null; now?: () => number }): void {
  state.model = opts.model;
  if (opts.site !== undefined) state.site = opts.site;
  clock = opts.now;
  handle = null;
}
let clock: (() => number) | undefined;

/** The agent as a web handler: the card on GET, the A2A endpoint on POST. */
export async function bookingA2A(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && (url.pathname === CARD || url.pathname === WELL_KNOWN)) return Response.json(card(url.origin));
  if (!state.site) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'No availability source is configured.' } }, { status: 503 });
  handle ??= bookingEndpoint({
    card: card(url.origin),
    executor: new BookingExecutor(state.site, () => state.model, undefined, { now: clock }),
    tasks: new InMemoryTaskStore(),
    fromRelay,
  });
  return handle(req);
}

// ── Node's HTTP as fetch ────────────────────────────────────────────────────

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream),
    duplex: 'half',
  } as RequestInit);
}

/** Write a `Response` out, streaming its body: server-sent events must reach the relay one by one. */
function send(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as never).pipe(res);
}

export interface BookingAgentEnv {
  /** Server-side only: never VITE_-prefixed, never sent to the page. Unset: offered as unavailable, and the form takes bookings. */
  ANTHROPIC_API_KEY?: string;
  BOOKING_MODEL?: string;
  /** Signs the agent's posts to the sink, as the sink verifies them. */
  NXIS_WEBHOOK_SIGNING_SECRET?: string;
  /** Where the booking form posts. Default: this server's /api/book. */
  BOOKING_SINK_URL?: string;
  /** The site's free-slot endpoint. Unset (and no example calendar): unavailable. */
  BOOKING_AVAILABILITY_URL?: string;
  /** Sent as `Authorization: Bearer …` to the availability endpoint, if it wants one. */
  BOOKING_AVAILABILITY_TOKEN?: string;
  /** "true": the in-memory example calendar. Trying it out only. */
  BOOKING_EXAMPLE_CALENDAR?: string;
  /** Set when another agent already serves /.well-known/agent-card.json. */
  BOOKING_CARD_WELL_KNOWN?: string;
}

export function bookingAgentPlugin(env: BookingAgentEnv): Plugin {
  const model = env.BOOKING_MODEL || DEFAULT_BOOKING_MODEL;
  state.model = env.ANTHROPIC_API_KEY ? claudeModel(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) as unknown as MessagesClient, model) : null;
  secret = env.NXIS_WEBHOOK_SIGNING_SECRET || undefined;
  const availability = env.BOOKING_AVAILABILITY_URL
    ? httpAvailability({ url: () => env.BOOKING_AVAILABILITY_URL!, headers: (): Record<string, string> => (env.BOOKING_AVAILABILITY_TOKEN ? { Authorization: `Bearer ${env.BOOKING_AVAILABILITY_TOKEN}` } : {}) })
    : env.BOOKING_EXAMPLE_CALENDAR === 'true'
      ? memoryAvailability()
      : null;
  state.site = availability
    ? exampleSite({ availability, sink: webhookSink({ url: () => env.BOOKING_SINK_URL || sinkUrl(), timeZone: RULES.timeZone, get secret() { return secret; } }) })
    : null;
  const wellKnown = env.BOOKING_CARD_WELL_KNOWN !== 'false';

  const install = (server: ViteDevServer | PreviewServer) => {
    // Post to this server itself, on whatever port it got.
    sinkUrl = () => {
      const address = server.httpServer?.address();
      return `http://localhost:${address && typeof address === 'object' ? address.port : 5173}/api/book`;
    };
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== PATH && path !== CARD && !(wellKnown && path === WELL_KNOWN)) return next();
      try {
        send(res, await bookingA2A(toRequest(req)));
      } catch (err) {
        console.error('[booking] failed:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'booking failed.' }));
      }
    });
    console.info(
      `[booking] Booking Agent at ${PATH} — ${!state.model ? 'no ANTHROPIC_API_KEY, so offered as unavailable' : !state.site ? 'no BOOKING_AVAILABILITY_URL, so offered as unavailable' : model}`,
    );
    if (!env.BOOKING_AVAILABILITY_URL && env.BOOKING_EXAMPLE_CALENDAR === 'true') console.warn('[booking] BOOKING_EXAMPLE_CALENDAR=true: the example calendar, not the business\'s.');
  };
  return { name: 'booking-agent', configureServer: install, configurePreviewServer: install };
}
