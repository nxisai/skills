/**
 * hosts/netlify.ts — the Booking Agent as a Netlify function.
 *
 * Put it at netlify/functions/a2a-booking/a2a-booking.mts, with agent-core.ts and
 * the site adapter beside it (or in a shared folder outside netlify/functions/:
 * every file directly in that directory is its own function).
 *
 * Status: DRAFT. Each piece is from Copperline's booking agent
 * (netlify/functions/a2a-booking.mts), which is verified in production: the
 * Blobs task store, the stale-task guard, relay-only auth, the body cap. This
 * core, with its availability check and claim, has not run on Netlify; say so
 * to the user, and run SKILL.md step 7 on a deploy preview before relying on it.
 *
 *   POST /a2a/booking                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/booking/agent-card.json    its Agent Card
 *
 * Serve /.well-known/agent-card.json too only if no other agent on the site
 * does (Copperline's is its booking agent's, a static file in public/).
 *
 * Host answers:
 * - Server code: this function. `netlify dev` serves it on http://localhost:8888.
 * - Where tasks live: Netlify Blobs, strong consistency — each request may
 *   land on a fresh instance, so the SDK's tasks AND agent-core's progress
 *   (the offer, the summary awaiting a yes, the attempt) both go in Blobs. In
 *   memory, the visitor's "yes" arrives at an instance that never showed them
 *   the summary, and nothing is booked. The claim is a `sent:<task>.<attempt>`
 *   key created with `onlyIfNew`.
 * - Secrets: site environment variables. A2A_RELAY_TOKEN is shared with the
 *   relay (its target's credential). ANTHROPIC_API_KEY, or Netlify's AI
 *   Gateway, which supplies the credential to `new Anthropic()` itself.
 * - Availability: BOOKING_AVAILABILITY_URL, the site's own free-slot endpoint
 *   (a function beside this one that reads the site's calendar). Unset: the
 *   agent is offered as unavailable and the booking form takes bookings.
 * - Expiry: Blobs keys don't expire. A completed task keeps only `submitted`
 *   and the reference; an abandoned conversation keeps what the visitor gave
 *   until the store is cleared. Add a scheduled function that deletes old
 *   `progress:` and `task:` keys if that matters to the user.
 * - Response time: about ten seconds per response. One model call a turn
 *   (2–4 s) fits; a turn cut off leaves its task "working", so a task found
 *   working for longer than a turn can take is failed on the next read.
 *
 * Needs @netlify/blobs and @netlify/functions in the project's dependencies.
 */
import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import Anthropic from '@anthropic-ai/sdk';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import { BookingExecutor, claudeModel, bookingAgentCard, bookingEndpoint, type MessagesClient, type Progress, type ProgressStore } from '../agent-core';
import { RULES, exampleSite, httpAvailability, webhookSink } from '../example-site';

const PATH = '/a2a/booking';
const CARD = `${PATH}/agent-card.json`;
const MODEL = process.env.BOOKING_MODEL || 'claude-sonnet-5-5';
/** Longer than any single turn takes; a task working for longer was cut off. */
const STALE_WORKING_MS = 90_000;

const blobs = () => getStore({ name: 'booking-agent', consistency: 'strong' });

// ── Tasks and progress in Blobs ─────────────────────────────────────────────

/** The SDK's tasks, in its own JSON. */
const taskStore: TaskStore = {
  async save(task) {
    await blobs().setJSON(`task:${task.id}`, SdkTask.toJSON(task));
  },
  async load(taskId) {
    const json = await blobs().get(`task:${taskId}`, { type: 'json' });
    return json ? SdkTask.fromJSON(json) : undefined;
  },
  // Each task belongs to one visitor; the relay never forwards ListTasks.
  async list() {
    return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
  },
};

/**
 * Whether this store honors conditional writes. Production Blobs does; the
 * `netlify dev` sandbox refuses every one — so probe once, and where it fails
 * fall back to read-then-write (a narrow race the relay's one-visitor-per-task
 * key already makes unlikely).
 */
let conditional: Promise<boolean> | null = null;
function conditionalWrites(): Promise<boolean> {
  conditional ??= (async () => {
    const store = blobs();
    const probe = '__conditional-write-probe';
    await store.setJSON(probe, { at: Date.now() });
    const found = await store.getWithMetadata(probe, { type: 'json' });
    return !!found?.etag && (await store.setJSON(probe, { at: Date.now() }, { onlyIfMatch: found.etag })).modified;
  })().catch(() => false);
  return conditional;
}

const progressStore: ProgressStore = {
  get: async (id) => ((await blobs().get(`progress:${id}`, { type: 'json' })) as Progress | null) ?? null,
  set: async (id, p) => void (await blobs().setJSON(`progress:${id}`, p)),
  async delete(id) {
    await blobs().delete(`progress:${id}`);
  },
  /** The single-submit guarantee: a `sent:` key only the first claim can create. */
  async claim(id) {
    const store = blobs();
    if (await conditionalWrites()) return (await store.setJSON(`sent:${id}`, { at: Date.now() }, { onlyIfNew: true })).modified;
    if (await store.get(`sent:${id}`)) return false;
    await store.setJSON(`sent:${id}`, { at: Date.now() });
    return true;
  },
};

/** Fail a task a timed-out turn left working, so a resubscribing client learns it is over. */
async function settleStale(taskId: string): Promise<void> {
  const json = (await blobs().get(`task:${taskId}`, { type: 'json' })) as { status?: { state?: string; timestamp?: string } } | null;
  const status = json?.status;
  if (status?.state !== 'TASK_STATE_WORKING' || !status.timestamp) return;
  if (Date.now() - Date.parse(status.timestamp) < STALE_WORKING_MS) return;
  await blobs().setJSON(`task:${taskId}`, {
    ...json,
    status: {
      state: 'TASK_STATE_FAILED',
      timestamp: new Date().toISOString(),
      message: { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: "Sorry — that took too long. The site's booking form still works." }] },
    },
  });
}

// ── The agent ───────────────────────────────────────────────────────────────

/** Whether it can take a handoff now: only with a model credential. The relay's target imports this as `availability`. */
export const bookingAvailability = async () => ({ available: Boolean(process.env.ANTHROPIC_API_KEY && process.env.BOOKING_AVAILABILITY_URL) });

/** The relay's credential. No default: unset, nothing may call the agent. */
const fromRelay = (req: Request) => {
  const token = process.env.A2A_RELAY_TOKEN;
  return !!token && req.headers.get('authorization') === `Bearer ${token}`;
};

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
  });

// EXAMPLE sink: the endpoint the site's form posts to, fixed server-side. For a form whose
// handler saves to the site's own database, use appSink with the handler's save function.
const site = exampleSite({
  availability: httpAvailability({
    url: () => {
      if (!process.env.BOOKING_AVAILABILITY_URL) throw new Error('BOOKING_AVAILABILITY_URL is not set');
      return process.env.BOOKING_AVAILABILITY_URL;
    },
    headers: (): Record<string, string> => (process.env.BOOKING_AVAILABILITY_TOKEN ? { Authorization: `Bearer ${process.env.BOOKING_AVAILABILITY_TOKEN}` } : {}),
  }),
  sink: webhookSink({ url: () => process.env.BOOKING_SINK_URL ?? `${process.env.URL}/api/book`, secret: process.env.NXIS_WEBHOOK_SIGNING_SECRET, timeZone: RULES.timeZone }),
});

let handle: ((req: Request) => Promise<Response>) | null = null;

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === CARD) return Response.json(card(url.origin));
  handle ??= bookingEndpoint({
    card: card(url.origin),
    executor: new BookingExecutor(site, () =>
      process.env.ANTHROPIC_API_KEY && process.env.BOOKING_AVAILABILITY_URL ? claudeModel(new Anthropic() as unknown as MessagesClient, MODEL) : null,
      progressStore,
    ),
    tasks: taskStore,
    fromRelay,
    beforeRead: settleStale,
  });
  return handle(req);
};

export const config: Config = {
  path: [PATH, CARD],
  method: ['GET', 'POST'],
};
