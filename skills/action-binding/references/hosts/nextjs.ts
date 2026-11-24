/**
 * hosts/nextjs.ts — the action receiver as a Next.js App Router route handler.
 *
 * Put it at app/api/nxis/action/route.ts (src/app/… where the project uses
 * src/), with receiver.ts, submissions.ts and bookings.ts in a folder outside
 * app/ (say lib/nxis/), and fix the three imports. The address is then
 * https://<the site's verified host>/api/nxis/action.
 *
 * Detect: `next` in package.json and an app/ (or src/app/) directory. For the
 * Pages Router (pages/api/), don't use this file as is: a pages/api route
 * parses JSON before the handler sees it, so it needs
 * `export const config = { api: { bodyParser: false } }` and the body read from
 * the stream; prefer an App Router route, which can live beside pages/.
 *
 * A static export (`output: "export"` in next.config) has no server: route
 * handlers are not deployed, and a POST to this path finds nothing. Use the
 * host's function instead (netlify.ts, vercel.ts or cloudflare.ts), at the
 * same path.
 *
 * Raw body: `req.text()`/`req.arrayBuffer()` in a route handler is the body as
 * sent; nothing parses it first. receiver.ts reads the bytes and caps them.
 *
 * Local: `next dev` serves this route (http://localhost:3000/api/nxis/action).
 * NxisAI can't reach localhost; to try it end to end, run it behind an https
 * tunnel, or deploy a preview. Hosted on Netlify, `next dev` serves this route
 * but not the project's netlify/functions; `netlify dev` serves both.
 *
 * Secrets: NXIS_ACTION_SECRET from .env.local locally (the file
 * `nxis connections create --write-env .env.local` writes), and from the
 * host's environment in production. Read at request time, so a rotation needs
 * only a redeploy of the environment, not of the code.
 *
 * Dedupe: memoryStore() lasts as long as one server instance. On a serverless
 * host (Vercel, Netlify) give receiver.ts a shared store; see IdempotencyStore.
 * Seats and holds (bookings.ts) the same: memorySlotStore() is per instance,
 * so on a serverless host two visitors can hold the last seat. Use the
 * SlotStore that host's file describes (Redis on Vercel, Blobs on Netlify).
 */
import { handleRequest, memoryStore, secretsFrom } from './receiver';
import { bookingCalendar, memorySlotStore } from './bookings';
import { calendar, check, deliver } from './submissions';

// Node.js runtime: the edge runtime works too (Web Crypto only), but the
// project's mailer or database client usually needs Node.
export const runtime = 'nodejs';
// Never cached or prerendered.
export const dynamic = 'force-dynamic';

const store = memoryStore();
const bookings = bookingCalendar({ ...calendar, store: memorySlotStore() });

export async function POST(req: Request): Promise<Response> {
  return handleRequest(req, { secrets: secretsFrom(process.env), store, deliver, check, bookings });
}
