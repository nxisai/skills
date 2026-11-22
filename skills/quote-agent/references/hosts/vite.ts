/**
 * hosts/vite.ts — the Quote Agent on a Node server: a Vite plugin for the dev
 * and preview servers. The same handler serves as Express middleware.
 *
 * Status: verified on a Vite dev server behind a tunnel (the listings example,
 * Royal Oak Quotes: typed request, result-card CTA, NxisAI app link, form
 * fallback, conversion report). A production Node deployment is unconfirmed:
 * tasks and progress live in this process's memory, which is right for one
 * long-lived process and wrong for several (see "Where tasks live").
 *
 *   POST /a2a/quote                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/quote/agent-card.json    its Agent Card
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
 *   On separate processes, set QUOTE_AGENT_TOKEN on both.
 * - Response time: no limit. A tunnel may cut idle streams; the harness resumes.
 *
 * In vite.config.ts:
 *
 *   const env = loadEnv(mode, process.cwd(), '');
 *   plugins: [ ..., quoteAgentPlugin(env), handoffPlugin(env) ]
 *
 * and in the relay adapter (agent-handoff), the target:
 *
 *   { name: 'quote', kind: 'agent', label: 'Ridgeline Quotes', description: '…',
 *     endpoint: '/a2a/quote', credential: () => ({ Authorization: `Bearer ${RELAY_TOKEN}` }),
 *     transcript: false, push: false, availability: quoteAvailability }
 *
 * The relay may call `quoteA2A` in-process instead of over the network
 * (a `fetch` that routes '/a2a/quote' to it); the token is checked all the same.
 */
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import { QuoteExecutor, claudeModel, quoteAgentCard, quoteEndpoint, type MessagesClient, type QuoteModel, type QuoteSite } from '../agent-core';
import { exampleSite, webhookSink } from '../example-site';

const PATH = '/a2a/quote';
const CARD = `${PATH}/agent-card.json`;
const WELL_KNOWN = '/.well-known/agent-card.json';
/** A current Sonnet. Override with QUOTE_MODEL. */
export const DEFAULT_QUOTE_MODEL = 'claude-sonnet-5-5';

/** What the relay proves itself with. One process: fresh each start. Separate processes: QUOTE_AGENT_TOKEN on both. */
export const RELAY_TOKEN = process.env.QUOTE_AGENT_TOKEN || randomUUID();
const fromRelay = (req: Request) => req.headers.get('authorization') === `Bearer ${RELAY_TOKEN}`;

/** Where the form's sink is: this server's own, set once it is listening. Never an address a request supplied. */
let sinkUrl = () => 'http://localhost:5173/webhook';
let secret: string | undefined;

/** The model and the site. Set by the plugin; tests set their own with `useQuoteAgent`. */
const state: { model: QuoteModel | null; site: QuoteSite } = {
  model: null,
  site: exampleSite({ sink: webhookSink({ url: () => sinkUrl(), get secret() { return secret; } }) }),
};

/** Whether it can take a handoff now: only with a model. The relay target's `availability`. */
export const quoteAvailability = async () => ({ available: state.model !== null });

/** EXAMPLE: the card's words. The name matches QuoteSite.agentName and the relay's label. */
const card = (origin: string) =>
  quoteAgentCard({
    origin,
    path: PATH,
    name: 'Ridgeline Quotes',
    description:
      'Takes a roofing quote or estimate request in conversation — asks one question at a time, confirms the details with the visitor, sends it to Ridgeline Roofing, and returns a quote reference.',
    organization: 'Ridgeline Roofing',
    collects:
      "Collects the visitor's name, email, optional phone, the service, the timeline and a description of the job, confirms them with the visitor, sends them as the site's quote form would, and returns a quote reference.",
    examples: ['Can I get a quote for a new roof?', 'How much would it cost to replace my gutters?'],
    tags: ['quote', 'estimate', 'roofing', 'home services'],
  });

let handle: ((req: Request) => Promise<Response>) | null = null;

/** For tests: a scripted model, or none, and a site whose sink they can watch. Starts afresh. */
export function useQuoteAgent(opts: { model: QuoteModel | null; site?: QuoteSite }): void {
  state.model = opts.model;
  if (opts.site) state.site = opts.site;
  handle = null;
}

/** The agent as a web handler: the card on GET, the A2A endpoint on POST. */
export async function quoteA2A(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && (url.pathname === CARD || url.pathname === WELL_KNOWN)) return Response.json(card(url.origin));
  handle ??= quoteEndpoint({
    card: card(url.origin),
    executor: new QuoteExecutor(state.site, () => state.model),
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

export interface QuoteAgentEnv {
  /** Server-side only: never VITE_-prefixed, never sent to the page. Unset: offered as unavailable, and the form takes quotes. */
  ANTHROPIC_API_KEY?: string;
  QUOTE_MODEL?: string;
  /** Signs the agent's posts to the sink, as the sink verifies them. */
  NXIS_WEBHOOK_SIGNING_SECRET?: string;
  /** Set when another agent already serves /.well-known/agent-card.json. */
  QUOTE_CARD_WELL_KNOWN?: string;
}

export function quoteAgentPlugin(env: QuoteAgentEnv): Plugin {
  const model = env.QUOTE_MODEL || DEFAULT_QUOTE_MODEL;
  state.model = env.ANTHROPIC_API_KEY ? claudeModel(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) as unknown as MessagesClient, model) : null;
  secret = env.NXIS_WEBHOOK_SIGNING_SECRET || undefined;
  const wellKnown = env.QUOTE_CARD_WELL_KNOWN !== 'false';

  const install = (server: ViteDevServer | PreviewServer) => {
    // Post to this server itself, on whatever port it got.
    sinkUrl = () => {
      const address = server.httpServer?.address();
      return `http://localhost:${address && typeof address === 'object' ? address.port : 5173}/webhook`;
    };
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== PATH && path !== CARD && !(wellKnown && path === WELL_KNOWN)) return next();
      try {
        send(res, await quoteA2A(toRequest(req)));
      } catch (err) {
        console.error('[quote] failed:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'quote failed.' }));
      }
    });
    console.info(`[quote] Quote Agent at ${PATH} — ${state.model ? model : 'no ANTHROPIC_API_KEY, so offered as unavailable'}`);
  };
  return { name: 'quote-agent', configureServer: install, configurePreviewServer: install };
}
