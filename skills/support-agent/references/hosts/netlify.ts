/**
 * hosts/netlify.ts — the Support Agent as a Netlify function. The first host
 * profile: the relay is verified on Netlify, and Blobs is enough, since
 * a read-only agent needs no submit claim.
 *
 * Put it at netlify/functions/a2a-support/a2a-support.mts, with support-core.ts
 * and the site adapter in a shared folder outside netlify/functions/ (every
 * file directly in that directory is its own function).
 *
 * Status: DRAFT. The Blobs task store, the stale-task guard, relay-only auth
 * and the body cap are the Quote Agent's Netlify pieces, from a booking agent
 * verified in production. The Support Agent itself has not run on Netlify end
 * to end; say so to the user, and run SKILL.md step 7 on a deploy preview.
 *
 *   POST /a2a/support                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/support/agent-card.json    its Agent Card
 *
 * Host answers:
 * - Server code: this function. `netlify dev` serves it on http://localhost:8888.
 * - Where tasks live: Netlify Blobs, strong consistency. Each request may land on
 *   a fresh instance, so the SDK's tasks AND support-core's context both go in
 *   Blobs. The context holds the last six exchanges (rewritten queries and what
 *   they cited), the scope, an offer of a person awaiting a yes, the last 20
 *   answers (answerId → the cited @ids, the rewritten query, the vote) and the
 *   gap one-shot flags (a short key per question reported). No visitor text,
 *   except with SUPPORT_TURN_REF_SECRET set: each of those answers' prompt and
 *   reply, for its 👎.
 *   Lost context degrades to "please ask again", and loses that task's thumbs.
 * - Secrets: site environment variables. A2A_RELAY_TOKEN is shared with the relay
 *   (its target's credential). ANTHROPIC_API_KEY is the owner's model key.
 *   SUPPORT_MCP_ENDPOINT is the site's MCP server. SUPPORT_GAP_KEY is the
 *   site-scoped key (scope content_gaps:report) and SUPPORT_PROVISIONING_ENDPOINT
 *   the provisioning MCP server it reports to; without both, nothing is sent.
 *   SUPPORT_TURN_REF_SECRET (32+ characters, `openssl rand -hex 32`) keys the
 *   question keys and turn references; without it, no gap or close reports.
 * - Gap reports go after the reply, fire and forget, kept alive past the
 *   response with the request's `context.waitUntil`.
 * - Reported questions and turns: Netlify Blobs, in their own store
 *   (`support-turns`): `question/<key>` for a gap question's wording and
 *   `turn/<ref>` for a turn. A function instance's files don't last, so the
 *   development file store doesn't fit. A gap report carries only the key and
 *   the ref. Blobs has no expiry: delete old entries on the owner's retention
 *   (a scheduled function listing by prefix), or pass a TurnStore over the
 *   site's own database to exampleSite instead. Read one with
 *   `netlify blobs:get support-turns question/<key>`.
 * - Response time: about ten seconds per synchronous response; streamed
 *   responses run longer. A turn is a rewrite (about 1 s), up to seven reads
 *   and a compose (2–4 s), with one retry. A turn cut off leaves its task
 *   "working", so a task found working for longer than a turn takes is failed on
 *   the next read.
 *
 * Needs @netlify/blobs and @netlify/functions in the project's dependencies.
 */
import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import Anthropic from '@anthropic-ai/sdk';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import { SupportExecutor, claudeSupportModel, helpReachable, supportAgentCard, supportEndpoint, type ContextStore, type MessagesClient, type SupportContext, type TurnStore } from '../support-core';
import { exampleSite, turnStoreFromEnv } from '../example-site';

const PATH = '/a2a/support';
const CARD = `${PATH}/agent-card.json`;
const COMPOSE = process.env.SUPPORT_MODEL || 'claude-sonnet-5-5';
const REWRITE = process.env.SUPPORT_REWRITE_MODEL || 'claude-haiku-5-5';
/** Longer than any single turn takes; a task working for longer was cut off. */
const STALE_WORKING_MS = 90_000;

const blobs = () => getStore({ name: 'support-agent', consistency: 'strong' });

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

/** The task's context. Deleted when the task completes; Blobs has no expiry, so nothing else lingers. */
const contextStore: ContextStore = {
  get: async (id) => ((await blobs().get(`context:${id}`, { type: 'json' })) as SupportContext | null) ?? null,
  set: async (id, c) => void (await blobs().setJSON(`context:${id}`, c)),
  delete: async (id) => void (await blobs().delete(`context:${id}`)),
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
      message: { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Sorry, that took too long. Please ask again.' }] },
    },
  });
}

/** Reported questions and turns, in their own Blobs store: the host's, never sent anywhere. */
const kept = () => getStore({ name: 'support-turns', consistency: 'strong' });
const blobTurns: TurnStore = {
  async save(ref, turn) {
    await kept().setJSON(`turn/${ref}`, { ref, ...turn });
  },
  // Asked again: firstSeen stays, lastSeen moves on.
  async saveQuestion(key, q) {
    const held = (await kept().get(`question/${key}`, { type: 'json' })) as { firstSeen?: string } | null;
    await kept().setJSON(`question/${key}`, { key, question: q.question, firstSeen: held?.firstSeen ?? q.at, lastSeen: q.at });
  },
};

// The secret's checks (32+ characters) are turnStoreFromEnv's; the questions and turns go to Blobs, not its file.
const { turnRefSecret } = turnStoreFromEnv({ SUPPORT_TURN_REF_SECRET: process.env.SUPPORT_TURN_REF_SECRET });
const site = exampleSite({ turns: turnRefSecret ? blobTurns : null, turnRefSecret });
const reachable = helpReachable(site.records);
const baseURL = process.env.SUPPORT_MODEL_BASE_URL || undefined;
const modelConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || baseURL);

/** Whether it can take a handoff now: a model credential and a reachable help corpus. The relay's target imports this. */
export const supportAvailability = async () => ({ available: modelConfigured() && (await reachable()) });

/** The relay's credential. No default: unset, nothing may call the agent. */
const fromRelay = (req: Request) => {
  const token = process.env.A2A_RELAY_TOKEN;
  return !!token && req.headers.get('authorization') === `Bearer ${token}`;
};

/** EXAMPLE: the card's words. The name matches SupportSite.agentName and the relay's label. */
const card = (origin: string) =>
  supportAgentCard({
    origin,
    path: PATH,
    name: 'Ridgeline Help',
    description: "Answers questions about Ridgeline Air's purifiers from Ridgeline's own help content — FAQs, guides, articles and videos — with a source for every answer.",
    organization: 'Ridgeline Air',
    examples: ['How do I replace the filter on the X200?', 'What does the warranty cover?'],
  });

let handle: ((req: Request) => Promise<Response>) | null = null;
/** The request in hand: one at a time per instance. Its `waitUntil` keeps a gap report alive past the response. */
let current: Context | null = null;

export default async (req: Request, context: Context) => {
  current = context;
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === CARD) return Response.json(card(url.origin));
  handle ??= supportEndpoint({
    card: card(url.origin),
    executor: new SupportExecutor(
      site,
      () =>
        modelConfigured()
          ? claudeSupportModel(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'proxied', ...(baseURL ? { baseURL } : {}) }) as unknown as MessagesClient, {
              compose: COMPOSE,
              rewrite: REWRITE,
              modelHeader: !!baseURL,
            })
          : null,
      contextStore,
      { keepAlive: (p) => current?.waitUntil?.(p) },
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
