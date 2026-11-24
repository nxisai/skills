/**
 * hosts/node.ts — the action receiver on a Node server: an Express route and
 * a Fastify plugin. Use the one the project runs; delete the other.
 *
 * Put it beside the server's other routes, with receiver.ts,
 * submissions.ts and bookings.ts, and mount it at /api/nxis/action. The address is then
 * https://<the host the server answers on>/api/nxis/action.
 *
 * Detect: `express` or `fastify` in package.json, and a server the project
 * starts itself (`app.listen`), deployed to a VM, a container, Render, Fly,
 * Railway or similar.
 *
 * Raw body, the thing that breaks most receivers here:
 *   - Express: `express.json()` mounted app-wide parses the body before any
 *     route sees it, and the signature can never match the re-serialized
 *     object. The route below takes `express.raw()` itself; mount it BEFORE
 *     `app.use(express.json())`, or exclude this path from it.
 *   - Fastify: the default JSON parser does the same. The plugin below
 *     replaces it inside its own encapsulated scope only, so the rest of the
 *     app keeps parsing JSON.
 *
 * Local: the server's own dev command. NxisAI can't reach localhost; an https
 * tunnel to the port (`cloudflared tunnel --url http://localhost:3000`, or
 * ngrok) gives an address to try it with.
 *
 * Secrets: NXIS_ACTION_SECRET from the environment: `node --env-file=.env`,
 * dotenv, or the platform's settings in production.
 *
 * Dedupe: memoryStore() is enough for one long-running instance. With more
 * than one, or across restarts, back the IdempotencyStore with Redis
 * (`SET NX`) or the database deliver() writes to.
 *
 * Seats and holds (bookings.ts): memorySlotStore() is the same, right for one
 * instance and lost on a restart (open holds and bookings with it). With more
 * than one, give it a SlotStore on Redis (`SET NX` to create, a Lua compare of
 * a version field to replace) or a table with a unique key and a version column.
 */
import type { Request as ExpressRequest, Response as ExpressResponse, Router } from 'express';
import express from 'express';
import type { FastifyInstance } from 'fastify';
import { MAX_BODY_BYTES, memoryStore, receive, secretsFrom, type Answer } from './receiver';
import { bookingCalendar, memorySlotStore } from './bookings';
import { calendar, check, deliver } from './submissions';

export const ACTION_PATH = '/api/nxis/action';

const store = memoryStore();
const bookings = bookingCalendar({ ...calendar, store: memorySlotStore() });
const options = () => ({ secrets: secretsFrom(process.env), store, deliver, check, bookings });

const headerOf = (headers: Record<string, string | string[] | undefined>) => (name: string) => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(',') : (v ?? null);
};

// ── Express ──────────────────────────────────────────────────────────────────

/** `app.use(nxisActionRouter())`, before `app.use(express.json())`. */
export function nxisActionRouter(): Router {
  const router = express.Router();
  router.post(
    ACTION_PATH,
    // Every content type, as bytes: the signature covers them exactly.
    express.raw({ type: () => true, limit: MAX_BODY_BYTES }),
    async (req: ExpressRequest, res: ExpressResponse) => {
      const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
      const answer = await receive({ method: req.method, url: req.originalUrl, body, header: headerOf(req.headers) }, options());
      send(res, answer);
    },
  );
  // express.raw() refuses a larger body with 413 before the route runs.
  return router;
}

function send(res: ExpressResponse, answer: Answer) {
  for (const [k, v] of Object.entries(answer.headers ?? {})) res.setHeader(k, v);
  res.status(answer.status).json(answer.body);
}

// ── Fastify ──────────────────────────────────────────────────────────────────

/** `app.register(nxisActionPlugin)`. */
export async function nxisActionPlugin(app: FastifyInstance): Promise<void> {
  // Encapsulated: this replaces JSON parsing for this plugin's routes only.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
  app.post(ACTION_PATH, async (req, reply) => {
    const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
    const answer = await receive({ method: req.method, url: req.url, body, header: headerOf(req.headers) }, options());
    return reply.code(answer.status).headers(answer.headers ?? {}).send(answer.body);
  });
}
