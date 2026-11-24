/**
 * hosts/netlify.ts — the action receiver as a Netlify Function (the v2 API:
 * a default export taking a web Request).
 *
 * Put it at netlify/functions/nxis-action.mts, with receiver.ts,
 * submissions.ts and bookings.ts in a folder outside netlify/functions/ (say netlify/lib/):
 * every file directly in that directory is its own function. `config.path`
 * below serves it at https://<the site's verified host>/api/nxis/action;
 * without it, Netlify serves it at /.netlify/functions/nxis-action.
 *
 * Detect: netlify.toml, a netlify/ directory, or `@netlify/` packages in
 * package.json. Works for a static site or a static export (a Next.js
 * `output: "export"`, a Vite or Astro build): the function runs beside it.
 *
 * Raw body: a v2 function gets the request as sent; nothing parses it.
 *
 * Local: `netlify dev` serves functions (http://localhost:8888/api/nxis/action),
 * with the site. A framework's own dev server (`next dev`, `vite`) does not
 * serve netlify/functions. To let NxisAI reach it, run `netlify dev --live`
 * (a public https address) or another https tunnel, or use a deploy preview.
 *
 * Secrets: `netlify dev` reads NXIS_ACTION_SECRET from .env (and the site's
 * environment variables when the project is linked); production reads the
 * site's environment variables: `netlify env:set NXIS_ACTION_SECRET …`,
 * copied from the env file, never from the conversation.
 *
 * Dedupe: each request can run on a fresh instance, so memoryStore() only
 * catches a retry that lands on the same one. TODO(nxis-action): back the
 * IdempotencyStore with Netlify Blobs (`getStore({ name, consistency:
 * "strong" })`, `claim` as `setJSON(key, …, { onlyIfNew: true })`) or the
 * database deliver() writes to, with a unique key.
 *
 * Seats and holds (bookings.ts) need the same: memorySlotStore() on a
 * serverless instance lets two visitors hold the last seat. TODO(nxis-action):
 * a SlotStore on Netlify Blobs, strongly consistent:
 *
 *   const blobs = getStore({ name: 'nxis-slots', consistency: 'strong' });
 *   get:     const r = await blobs.getWithMetadata(key, { type: 'json' });
 *            return r ? { value: r.data, version: r.etag } : null;
 *   create:  const r = await blobs.setJSON(key, value, { onlyIfNew: true });
 *            return r.modified ? r.etag : null;
 *   replace: const r = await blobs.setJSON(key, value, { onlyIfMatch: version });
 *            return r.modified ? r.etag : null;
 *   delete:  await blobs.delete(key);
 *
 * Blobs keeps keys until deleted; an expired hold counts as free anyway.
 */
import { handleRequest, memoryStore, secretsFrom } from './receiver';
import { bookingCalendar, memorySlotStore } from './bookings';
import { calendar, check, deliver } from './submissions';

const store = memoryStore();
const bookings = bookingCalendar({ ...calendar, store: memorySlotStore() });

export default async (req: Request): Promise<Response> =>
  handleRequest(req, { secrets: secretsFrom(process.env), store, deliver, check, bookings });

export const config = { path: '/api/nxis/action', method: 'POST' };
