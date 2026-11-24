/**
 * hosts/cloudflare.ts — the action receiver as a Cloudflare Worker.
 *
 * Use it as the Worker's `main` (say src/nxis-action.ts), with receiver.ts,
 * submissions.ts and bookings.ts beside it. receiver.ts uses Web Crypto only, so it needs no
 * `nodejs_compat`. In submissions.ts read configuration from `env` rather than
 * `process.env` (pass what deliver() needs through the Worker's bindings).
 *
 * Detect: wrangler.toml or wrangler.jsonc, a site on Cloudflare Pages, or a
 * site whose DNS is proxied through Cloudflare.
 *
 * Reach it at the site's own host: a route on the site's zone, in
 * wrangler.jsonc,
 *
 *   "routes": [{ "pattern": "example.com/api/nxis/action", "zone_name": "example.com" }]
 *
 * gives https://example.com/api/nxis/action. With Pages, a Pages Function at
 * functions/api/nxis/action.ts does the same: import this module's default
 * export as `worker` and export `onRequestPost = ({ request, env }) =>
 * worker.fetch(request, env)`.
 * A *.workers.dev address works too: the address doesn't have to be on the
 * site's domain.
 *
 * Raw body: a Worker gets the request as sent.
 *
 * Local: `wrangler dev` serves it on http://localhost:8787. NxisAI can't
 * reach localhost: `cloudflared tunnel --url http://localhost:8787` gives an
 * https address to try it with, or deploy.
 *
 * Secrets: `wrangler dev` reads .dev.vars (gitignore it; `--write-env
 * .dev.vars` writes the secret there); production: `wrangler secret put
 * NXIS_ACTION_SECRET`, pasted by the user from that file.
 *
 * Dedupe: an isolate's memory is not shared, so memoryStore() only catches a
 * retry that lands on the same one. TODO(nxis-action): back the
 * IdempotencyStore with a Durable Object (strongly consistent, so `claim` is
 * atomic) or D1 with a unique key. Workers KV is eventually consistent and
 * can't make `claim` atomic.
 *
 * Seats and holds (bookings.ts) need the same, or two visitors can hold the
 * last seat in two isolates. TODO(nxis-action): a SlotStore in one Durable
 * Object for the calendar (it runs one request at a time, so a version check
 * in its storage is atomic), or D1: `slots(key PRIMARY KEY, value, version)`,
 * `create` as `INSERT … ON CONFLICT DO NOTHING`, `replace` as `UPDATE … WHERE
 * key = ? AND version = ?`, each counting the rows changed. Not KV.
 */
import { handleRequest, memoryStore, secretsFrom } from './receiver';
import { bookingCalendar, memorySlotStore } from './bookings';
import { calendar, check, deliver } from './submissions';

export interface Env {
  NXIS_ACTION_SECRET?: string;
  NXIS_ACTION_SECRET_PREVIOUS?: string;
}

const store = memoryStore();
const bookings = bookingCalendar({ ...calendar, store: memorySlotStore() });

// Export only the handler: workerd refuses a main module that exports other values.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/api/nxis/action') return new Response('Not found', { status: 404 });
    return handleRequest(request, { secrets: secretsFrom({ ...env }), store, deliver, check, bookings });
  },
};
