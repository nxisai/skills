# Cloudflare Workers

**Status: draft — verified locally, not deployed.** The Worker in [`cloudflare/worker.ts`](cloudflare/worker.ts) has run under `wrangler dev` (workerd, local mode) with the real `@anthropic-ai/sdk` pointed at a scripted stand-in for the model API and a local stub sink: both cards, 403 without the relay's token, 413 over the body cap, a conversation to one signed submission with the sink's reference handed back, two concurrent "yes" that sent exactly once, a relay that disconnects mid-send, and no model key. It has never been deployed, never been called by a live relay, and never made a real model call. Tell the user it is a draft, run SKILL.md step 7 on a deployment before relying on it, and confirm each item marked **Unconfirmed** against Cloudflare's current documentation.

Detect: `wrangler.toml` or `wrangler.jsonc` in the project, a site on Cloudflare Pages, or a site whose DNS is on Cloudflare and whose owner would rather run the agent there than on the site's own server.

Choose it when:

- The site is on Cloudflare already — Workers with static assets, Pages, or any origin behind a Cloudflare zone — and the agent should share its origin
- The site's own host can't hold server state the way the agent needs (a static host), but its DNS is on Cloudflare
- The user wants the single-submit guarantee from strongly consistent storage without running a database

Don't choose it for a site whose host already runs the agent well (the vite or netlify profile), only to move it.

## 1. Where server code lives, and what it runs on locally

One Worker module: [`cloudflare/worker.ts`](cloudflare/worker.ts) as the Worker's `main` (say `src/quote-worker.ts`), with `agent-core.ts` and the site adapter beside it, and [`cloudflare/wrangler.jsonc`](cloudflare/wrangler.jsonc). It answers:

| Path | What |
|---|---|
| `POST /a2a/quote` | The A2A endpoint. Relay only: the bearer token is compared in constant time (`crypto.subtle.timingSafeEqual`) before the body is read; the body is capped at 64 KB **while it streams**, so a large body is refused (413) without being buffered |
| `GET /a2a/quote/agent-card.json` | The card, built per request from the request's origin |
| `GET /.well-known/agent-card.json` | The same card — set `QUOTE_CARD_WELL_KNOWN` to `"false"` if another agent on the site claims it, and leave that path out of the routes |

**How the page's relay reaches it.** Pick one shape:

- **A route on the site's zone (prefer this).** The site stays where it is; the Worker takes `example.com/a2a/quote*` and `example.com/.well-known/agent-card.json` (`routes` in `wrangler.jsonc`). Same origin as the page, no CORS, and the card points at the site's own origin. Needs the site's DNS proxied through Cloudflare
- **The Worker is the site** (Workers with static assets). Replace `routes` with the `assets` block in `wrangler.jsonc`, with `run_worker_first` listing the agent's paths; everything else falls through to `env.ASSETS`
- **Pages Functions.** A Pages project can't define a Durable Object class. Deploy this Worker separately and either route its paths on the zone as above, or bind the Pages project to the Worker's `QuoteTask` class (`script_name`) and mount the handler from a function. **Unconfirmed:** neither has been run with Pages
- **Its own origin** (`quote.example.com`, or `*.workers.dev`). Works — the relay calls the agent server to server, so there is no CORS — but the card then points at that origin, not the site's. Use it only when the site's zone isn't on Cloudflare

**The relay.** agent-handoff has no Cloudflare profile yet. If the relay also runs as a Worker, give it a **service binding** to this Worker and pass the binding's `fetch` to the relay as its `fetch` option (`handleHandoff` takes one), rather than fetching the agent's public URL. **Unconfirmed:** that a Worker's `fetch` to a route on its own zone reaches another Worker; Cloudflare documents service bindings for Worker-to-Worker calls.

Locally, `wrangler dev` serves the Worker on **`http://localhost:8787`**, with Durable Objects simulated on disk (`.wrangler/state`).

### Runtime compatibility (checked, not assumed)

- **`nodejs_compat` is required.** `@a2a-js/sdk` 1.2.1's server reads raw parts with `Buffer`, and `example-site.ts` signs webhook posts with `node:crypto`'s `createHmac`. With the flag, both run on workerd; the bundle is about 1.2 MB, 204 KB gzipped
- **`@a2a-js/sdk/server`**: `DefaultRequestHandler` and `JsonRpcTransportHandler` run unchanged; its only other import is `jose`, which supports Workers. The Express and gRPC entry points are Node-only and aren't used
- **`@anthropic-ai/sdk` 1.3.0** runs under `nodejs_compat`, with the key passed explicitly (`new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })`): Workers have no ambient `process.env` by default. Its file-based credential lookup (a dynamic import of `node:fs`) is bundled but wasn't reached with a key given. **Unconfirmed:** without `nodejs_compat`

## 2. Where tasks and progress live

**A Durable Object per task** (`QuoteTask`). The SDK's task JSON, agent-core's progress and the submit marker are three keys in that object's SQLite-backed storage. Every request for a task — from whichever Worker instance, in whichever location — reaches the same object, which runs one call at a time over strongly consistent storage. So the summary a visitor said yes to is there when the yes arrives, and the yes is read once.

**The conditional write.** `claim` reads and writes the `sent` marker with the synchronous `ctx.storage.kv` API: no `await` between the check and the set, so nothing else runs on the object in between, and of any number of concurrent claims exactly one gets `true`. The marker is kept when progress is deleted at the end of a task, so a late duplicate still finds it claimed.

**Not Workers KV.** KV is eventually consistent — a write can take up to a minute to be seen elsewhere — and has no conditional write. A "yes" can read a stale summary, and two claims can both succeed. Don't keep progress there, and never the claim. D1 would work with a conditional `INSERT … ON CONFLICT DO NOTHING`, but a Durable Object per task is simpler and needs no schema.

Each object sets an alarm that deletes its storage 30 days after the task was last touched.

## 3. Where secrets live

Worker secrets, read from `env` — never `vars`, which are stored in plain text in the config:

```sh
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put A2A_RELAY_TOKEN              # the same value as the relay's target credential
wrangler secret put NXIS_WEBHOOK_SIGNING_SECRET  # when the sink verifies signatures
```

`QUOTE_MODEL` and `QUOTE_SINK_URL` are `vars`. Locally, `.dev.vars` holds all of them (copy [`cloudflare/.dev.vars.example`](cloudflare/.dev.vars.example)), and `.dev.vars` goes in `.gitignore`. Unset `A2A_RELAY_TOKEN` means nothing can call the agent; unset `ANTHROPIC_API_KEY` means `quoteAvailability` is false and the relay lists `quote` as unavailable.

## 4. How long one response may take

What matters on Workers, with how this design stays inside it:

| Limit | Here |
|---|---|
| Wall-clock time per request | No hard limit while the relay stays connected. A turn is one model call (2–4 s) plus a few Durable Object calls; a "yes" turn is the claim plus the sink call, no model |
| CPU time per request | Free plan 10 ms; Paid 30 s by default, raisable with `limits.cpu_ms`. Waiting on the model, the sink and the Durable Object isn't CPU time. **Unconfirmed:** that a turn's JSON and SDK work stays under 10 ms on the Free plan — use Paid |
| Subrequests per request | 50 on Free, 1,000 on Paid. A turn uses about ten (Durable Object calls, the model, the sink). **Unconfirmed:** current numbers, and whether Durable Object calls count |
| Relay disconnects mid-turn | The Worker keeps reading the turn's events to the end under `ctx.waitUntil` (up to 30 s after the response ends), so a claimed submission is still sent and the task recorded `COMPLETED` with its reference. Verified locally; **Unconfirmed:** that production cancels the turn without this |
| A turn cut off anyway | Its task is left `WORKING`; the next `GetTask` or `SubscribeToTask` fails it if it has been working for more than 90 s (`settleStale`, run in the object) |

Streaming: `SendStreamingMessage` answers as server-sent events, one A2A event each, passed through as they're produced. **Unconfirmed:** that nothing between the relay and the Worker buffers them in production (locally, each arrived as its own event).

## Also on Cloudflare

- **Durable Objects on the Free plan** need SQLite-backed classes (`new_sqlite_classes` in the migration), which this profile uses. **Unconfirmed:** current Free-plan Durable Object quotas
- **Two "yes" on one Worker instance.** The A2A SDK shares one event stream per task within an instance: when the losing "yes" finishes ("already sent"), it closes the winning one's stream too. Exactly one submission is still made and recorded, but the relay may see "already sent" without the reference. It takes two messages for one task in flight at once — a retry racing its original
- **Rate limiting** is the relay's job, as on every host. A Workers Rate Limiting binding in front of `/a2a/quote` is possible but not needed: only the relay holds the token
- **Preview URLs** (`*.workers.dev`, versions) serve the card for their own origin; the relay must point at the deployment it means to use

## Proving it

On `wrangler dev`, with the model and the sink stubbed (a scripted model needs no key; never commit one):

| Check | Expect |
|---|---|
| `curl localhost:8787/a2a/quote/agent-card.json` and `/.well-known/agent-card.json` | The card, `supportedInterfaces[0].url` on the origin requested |
| `POST /a2a/quote` with no, a wrong, or a same-length wrong `Authorization` | 403 |
| A 70 KB body, with and without `Content-Length` | 413 |
| A conversation to the summary, then "yes" | `COMPLETED`, a `resolved` hand-back with the sink's reference; the sink got one signed post, identical to the form's payload |
| The same "yes" sent twice at once | One post to the sink; one reply resolved, the other "already sent" |
| No `ANTHROPIC_API_KEY` | The first turn hands back `unresolved`: "I can't take quote requests right now…" |

Then SKILL.md step 7 on the deployed Worker, through the site's relay.
