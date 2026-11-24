/**
 * hosts/vercel.ts — the action receiver as a Vercel Function (the web
 * signature: an exported POST taking a Request).
 *
 * Put it at api/nxis/action.ts at the project root, with receiver.ts,
 * submissions.ts and bookings.ts in a folder Vercel doesn't turn into routes (say lib/nxis/;
 * every file under api/ is its own function). The address is then
 * https://<the site's verified host>/api/nxis/action.
 *
 * Detect: vercel.json, a .vercel/ directory, or a project deployed to Vercel.
 * A Next.js app on Vercel uses nextjs.ts instead (its route handlers are its
 * functions). This file is for everything else on Vercel: a static site, a
 * static export, Vite, Astro, SvelteKit's static adapter.
 *
 * Raw body: with the web signature, `request` is the body as sent. (The older
 * `(req, res)` Node signature parses JSON into req.body first; don't use it
 * here.)
 *
 * Local: `vercel dev` serves api/ (http://localhost:3000/api/nxis/action).
 * NxisAI can't reach localhost; use a preview deployment, or an https tunnel
 * to `vercel dev`. A preview deployment behind Vercel Authentication refuses
 * NxisAI's call with 401 before this code runs: allow it through (protection
 * bypass) or test on production.
 *
 * Secrets: `vercel dev` reads .env.local (or `vercel env pull`); production
 * reads the project's environment variables: `vercel env add
 * NXIS_ACTION_SECRET production`, pasted from the env file by the user.
 *
 * Dedupe: instances are short-lived and many, so memoryStore() only catches a
 * retry that lands on the same one. TODO(nxis-action): back the
 * IdempotencyStore with Redis from the Vercel Marketplace (`SET key value NX
 * EX ttl` for `claim`) or the database deliver() writes to, with a unique key.
 *
 * Seats and holds (bookings.ts) need the same, or two visitors can hold the
 * last seat on two instances. TODO(nxis-action): a SlotStore on the same
 * Redis: keep `{ version, value }` under the key; `create` is `SET key …
 * NX EX ttl`; `replace` is a short Lua script that compares the stored
 * version and writes only when it matches; `delete` the same compare, then
 * `DEL`. Or a table with a unique key and a version column in the database.
 */
import { handleRequest, memoryStore, secretsFrom } from './receiver';
import { bookingCalendar, memorySlotStore } from './bookings';
import { calendar, check, deliver } from './submissions';

const store = memoryStore();
const bookings = bookingCalendar({ ...calendar, store: memorySlotStore() });

export async function POST(request: Request): Promise<Response> {
  return handleRequest(request, { secrets: secretsFrom(process.env), store, deliver, check, bookings });
}
