/**
 * hosts/vite.ts — the Support Agent on a Node server: a Vite plugin for the
 * dev and preview servers. The same handler serves as Express middleware.
 *
 * Status: DRAFT, development only. The in-process tests run against
 * this file; a live server has run it only locally against a fixture site's
 * MCP server. Tasks and context live in this process's memory, which is right
 * for one long-lived process and wrong for several.
 *
 *   POST /a2a/support                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/support/agent-card.json    its Agent Card
 *
 * Host answers:
 * - Server code: a plugin's `configureServer` / `configurePreviewServer` middleware.
 * - Where tasks live: the SDK's InMemoryTaskStore and support-core's memoryContext():
 *   the last exchanges, the scope, the last 20 answers (answerId → the cited @ids,
 *   the rewritten query, the vote) and the gap one-shot flags. No visitor text, except
 *   with SUPPORT_TURN_REF_SECRET set: each of those answers' prompt and reply, for its 👎.
 * - Secrets: the process environment, loaded with `loadEnv(mode, cwd, '')` in
 *   vite.config.ts. Never a VITE_-prefixed variable: those are compiled into the page.
 * - Relay credential: the relay and this agent in one process share a fresh
 *   random token per start (RELAY_TOKEN below). On separate processes, set
 *   SUPPORT_AGENT_TOKEN on both.
 * - Response time: no limit. A turn is two model calls and up to seven reads.
 * - Gap reports: SUPPORT_GAP_KEY (the site-scoped key) and SUPPORT_PROVISIONING_ENDPOINT,
 *   server-side. Without both, none are sent. The process outlives each response, so
 *   fire and forget needs nothing more.
 * - Question keys and turn references: SUPPORT_TURN_REF_SECRET (32+ characters,
 *   `openssl rand -hex 32`). A gap report names its question by an HMAC of it and its turn
 *   by an HMAC of the prompt and reply; the wording, the prompt and the reply go to a JSON
 *   Lines file at SUPPORT_TURN_STORE (default .support/turns.jsonl, git-ignored) and nowhere
 *   else. Without the secret there is no key, so no gap or close report is sent (👍 counts
 *   still are). Read a gap with `findGapQuestion(path, key)` and `findTurn(path, ref)` from
 *   example-site.ts, or the whole list with `gapsWithWording(gaps, fileGapLookup(path))`.
 *   The file is for development: a real site keeps these in its own database.
 *
 * In vite.config.ts:
 *
 *   const env = loadEnv(mode, process.cwd(), '');
 *   plugins: [ ..., supportAgentPlugin(env), handoffPlugin(env) ]
 *
 * and in the relay adapter (agent-handoff), the target:
 *
 *   { name: 'support', kind: 'agent', label: 'Ridgeline Help', description: '…',
 *     endpoint: '/a2a/support', credential: () => ({ Authorization: `Bearer ${RELAY_TOKEN}` }),
 *     transcript: false, push: false, availability: supportAvailability }
 */
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import { SupportExecutor, claudeSupportModel, gapSinkFromEnv, helpReachable, memoryContext, supportAgentCard, supportEndpoint, type MessagesClient, type SupportModel, type SupportSite } from '../support-core';
import { exampleSite, turnStoreFromEnv } from '../example-site';

const PATH = '/a2a/support';
const CARD = `${PATH}/agent-card.json`;
/** Sonnet composes, Haiku rewrites. Override with SUPPORT_MODEL and SUPPORT_REWRITE_MODEL. */
export const DEFAULT_SUPPORT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_SUPPORT_REWRITE_MODEL = 'claude-haiku-5-5';

/** What the relay proves itself with. One process: fresh each start. Separate processes: SUPPORT_AGENT_TOKEN on both. */
export const RELAY_TOKEN = process.env.SUPPORT_AGENT_TOKEN || randomUUID();
const fromRelay = (req: Request) => req.headers.get('authorization') === `Bearer ${RELAY_TOKEN}`;

export interface SupportAgentEnv {
  /** Server-side only. Unset (and no SUPPORT_MODEL_BASE_URL): offered as unavailable. */
  ANTHROPIC_API_KEY?: string;
  SUPPORT_MODEL?: string;
  SUPPORT_REWRITE_MODEL?: string;
  /**
   * A Messages API base URL in front of Anthropic's, such as the model bench's proxy, which
   * meters and pins both models. Each call then names its model on X-Nxis-Model.
   */
  SUPPORT_MODEL_BASE_URL?: string;
  /** The site's MCP server, fixed server-side. */
  SUPPORT_MCP_ENDPOINT?: string;
  /** The site-scoped key (scope content_gaps:report) gap reports are sent with. A secret: never VITE_-prefixed. */
  SUPPORT_GAP_KEY?: string;
  /** The provisioning MCP server `nxis_report_content_gap` is on. */
  SUPPORT_PROVISIONING_ENDPOINT?: string;
  /** The key question keys and turn references are made with: 32 characters or more. A secret: never VITE_-prefixed. Unset: no gap or close reports. */
  SUPPORT_TURN_REF_SECRET?: string;
  /** The JSON Lines file reported questions and turns are kept in. Default: .support/turns.jsonl. */
  SUPPORT_TURN_STORE?: string;
}

/** The two models from the environment, or null when neither a key nor a proxy is set. */
export function modelFromEnv(env: SupportAgentEnv): SupportModel | null {
  const baseURL = env.SUPPORT_MODEL_BASE_URL || undefined;
  if (!env.ANTHROPIC_API_KEY && !baseURL) return null;
  // Through a proxy that holds its own key, the SDK still wants one: a placeholder never sent to Anthropic.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'proxied', ...(baseURL ? { baseURL } : {}) });
  return claudeSupportModel(client as unknown as MessagesClient, {
    compose: env.SUPPORT_MODEL || DEFAULT_SUPPORT_MODEL,
    rewrite: env.SUPPORT_REWRITE_MODEL || DEFAULT_SUPPORT_REWRITE_MODEL,
    modelHeader: !!baseURL,
  });
}

/** The model and the site. Set by the plugin; tests set their own with `useSupportAgent`. */
const state: { model: SupportModel | null; site: SupportSite; reachable: () => Promise<boolean>; executor: SupportExecutor | null } = {
  model: null,
  site: exampleSite(),
  reachable: async () => false,
  executor: null,
};
state.reachable = helpReachable(state.site.records);

/** Whether it can take a handoff now: a model, and a site MCP server that lists help content. */
export const supportAvailability = async () => ({ available: state.model !== null && (await state.reachable()) });

/** EXAMPLE: the card's words. The name matches SupportSite.agentName and the relay's label. */
const card = (origin: string) =>
  supportAgentCard({
    origin,
    path: PATH,
    name: 'Ridgeline Help',
    description: "Answers questions about Ridgeline Air's purifiers from Ridgeline's own help content — FAQs, guides, articles and videos — with a source for every answer.",
    organization: 'Ridgeline Air',
    examples: ['How do I replace the filter on the X200?', 'What does the warranty cover?'],
    tags: ['support', 'help', 'air purifier'],
  });

let handle: ((req: Request) => Promise<Response>) | null = null;

/** For tests: a scripted model, or none, and a site over stub records. Starts afresh. */
export function useSupportAgent(opts: { model: SupportModel | null; site?: SupportSite }): void {
  state.model = opts.model;
  if (opts.site) {
    state.site = opts.site;
    state.reachable = helpReachable(opts.site.records);
  }
  handle = null;
  state.executor = null;
}

/** The executor in use, for tests that read its last turn's trace. */
export const supportExecutor = () => state.executor;

/** The agent as a web handler: the card on GET, the A2A endpoint on POST. */
export async function supportA2A(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === CARD) return Response.json(card(url.origin));
  if (!handle) {
    state.executor = new SupportExecutor(state.site, () => state.model, memoryContext());
    handle = supportEndpoint({ card: card(url.origin), executor: state.executor, tasks: new InMemoryTaskStore(), fromRelay });
  }
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

function send(res: ServerResponse, response: Response): void {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as never).pipe(res);
}

export function supportAgentPlugin(env: SupportAgentEnv): Plugin {
  state.model = modelFromEnv(env);
  // loadEnv's values aren't in process.env, so the gap sink and the turn store are built from them here.
  if (env.SUPPORT_MCP_ENDPOINT) useSupportAgent({ model: state.model, site: exampleSite({ gaps: gapSinkFromEnv(env), ...turnStoreFromEnv(env) }) });

  const install = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== PATH && path !== CARD) return next();
      try {
        send(res, await supportA2A(toRequest(req)));
      } catch (err) {
        console.error('[support] failed:', err instanceof Error ? err.message : err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'support failed.' }));
      }
    });
    console.info(`[support] Support Agent at ${PATH} — ${state.model ? 'models configured' : 'no ANTHROPIC_API_KEY, so offered as unavailable'}`);
  };
  return { name: 'support-agent', configureServer: install, configurePreviewServer: install };
}
