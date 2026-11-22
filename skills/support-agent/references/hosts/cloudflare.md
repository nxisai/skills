# Cloudflare Workers

**Status: draft. Verified locally under `wrangler dev`, never deployed.** [`cloudflare/worker.ts`](cloudflare/worker.ts) with [`cloudflare/agent.ts`](cloudflare/agent.ts) ran under `wrangler dev --local` (workerd, with Durable Objects and KV simulated on disk), with the real `@anthropic-ai/sdk` pointed at a stand-in for the Messages API and stub MCP servers. These were checked: support-core's `turnRef` under `nodejs_compat` gives the test vector (`60150baf…5856da`); the card on the origin requested; `{"available":true}` on the health path; 403 without the token and with a same-length wrong one; 413 over 64 KB; a not-found turn answered in about 45 ms, with its gap report arriving at the stub provisioning server 1.5 s *after* the response had ended (under `waitUntil`), carrying its `ref`; the turn in KV under `turn:<ref>` expiring after the retention set; the visitor's "yes" on the next request handed back `transferred` (the context held in the task's Durable Object); no token, key or question in the dev log. `wrangler deploy --dry-run` bundles it at about 1.4 MB, 244 KB gzipped. The in-process tests (`cloudflare/worker.test.ts`) cover the routes, refusals, the KV turn, a follow-up from a second isolate and the stale-task guard over fakes. Not run: a deployment, a live relay, production Durable Objects or KV, a real model call, the Free plan's limits. Tell the user it is a draft.

Detect: `wrangler.toml` or `wrangler.jsonc` in the project, a site on Cloudflare Pages, or a site whose DNS is on Cloudflare and whose owner would rather run the agent there.

| Question | Cloudflare |
|---|---|
| Server code | A Worker: `worker.ts` as `main` (only the handler and the Durable Object class: workerd refuses a main module that exports a constant), `agent.ts` beside it. `wrangler dev` serves it on `http://localhost:8787` |
| Tasks and context | A Durable Object per task (`SupportTask`): the SDK's task and the core's context, two keys in its SQLite-backed storage. Deleted a day after the task was last touched |
| Questions and turns | Workers KV (`SUPPORT_TURNS`): `question:<question_key>` for a gap question's wording and `turn:<ref>` for a reported turn, with `expirationTtl` as the owner's retention. NxisAI gets the key and the ref, never the words |
| Secrets | `wrangler secret put`; the rest are `vars`. Locally, `.dev.vars` (gitignored) |
| Response time | No wall-clock limit while the relay is connected; CPU time is metered. Gap reports run under `ctx.waitUntil`, up to 30 s after the response |

## 1. Where server code lives, and how it is reached

```
src/
  support-worker.ts   ← hosts/cloudflare/worker.ts, importing './support-agent'
  support-agent.ts    ← hosts/cloudflare/agent.ts, importing './support-core' and './site'
  support-core.ts     ← unchanged
  site.ts             ← the SupportSite: every setting passed in from `env` (see envSite in agent.ts)
wrangler.toml         ← hosts/cloudflare/wrangler.toml
.dev.vars             ← gitignored (hosts/cloudflare/.dev.vars.example)
```

| Path | |
|---|---|
| `POST /a2a/support` | Relay only: the token compared in constant time (`crypto.subtle.timingSafeEqual`) before the body is read; the body capped at 64 KB while it streams |
| `GET /a2a/support/agent-card.json`, `GET /.well-known/agent-card.json` | The card, for the origin requested. `SUPPORT_CARD_WELL_KNOWN = "false"` if another agent claims the second |
| `GET /a2a/support/healthz` | `{ "available": … }`: a model, and a site MCP server that lists help content. For the relay's `availability` |

Reach it **on a route of the site's zone** (`example.com/a2a/support*`, as in `wrangler.toml`), so the card is on the site's origin; or, when the Worker is the site (static assets), with `run_worker_first` on the agent's paths. A relay that is itself a Worker should call it through a service binding. The quote-agent skill's `hosts/cloudflare.md` has the shapes; only the paths differ.

## 2. Runtime compatibility

**`nodejs_compat` is required**, with a recent `compatibility_date` (2026-10-01 here, the one verified; `node:fs` exists under `nodejs_compat` only from a 2025 date on. **Unconfirmed:** the exact cut-off):

- `support-core.ts` makes question keys and turn references with `createHmac` from `node:crypto`. Under `nodejs_compat`, workerd's `createHmac` gives the same bytes as Node's (the test vector above), so **`gapKey` and `turnRef` stay synchronous and unchanged**
- `@a2a-js/sdk` uses `Buffer`; `example-site.ts` imports `node:fs/promises` and `node:path` for its development file store, which the Worker never uses (it passes `turns` itself)
- `@anthropic-ai/sdk` runs with the key passed in from `env`: a Worker has no ambient `process.env` to read it from. So does every setting: `envSite` in agent.ts passes `records`, `gaps`, `turns` and `turnRefSecret` to `exampleSite`, whose defaults would read `process.env`
- `mcpRecords` and the gap sink use `fetch` only

## 3. Why a Durable Object for tasks and context, and KV for questions and turns

A follow-up must read the context its last turn wrote: the offer of a person awaiting a yes, the answers its 👍/👎 refer to. Requests for one task can land on any Worker instance anywhere; with a Durable Object per task they all reach the same object, which runs one call at a time over strongly consistent storage. **Not KV for these**: KV is eventually consistent (a write can take up to a minute to be seen elsewhere), so a "yes" seconds after the offer could read the context from before it. That is why the netlify profile uses Blobs with strong consistency, and it is the same reason here.

A gap question's wording and a reported turn are different: each is written before its report and read days later by the owner. Eventual consistency costs nothing there, and KV expires keys itself (`expirationTtl`, from `SUPPORT_TURN_RETENTION_DAYS`), where D1 would need a schema and a cron for retention. The owner reads one with

```sh
wrangler kv key get --binding SUPPORT_TURNS "question:<question_key>" --remote   # {key, question, firstSeen, lastSeen}
wrangler kv key get --binding SUPPORT_TURNS "turn:<ref>" --remote                # {ref, prompt, reply, …}
```

The key and the refs are what `nxis_list_content_gaps` returns for a gap; the words are only here. Create the namespace with `wrangler kv namespace create SUPPORT_TURNS` and put its id in `wrangler.toml`. Without the binding or the secret there is no question key, so **no gap or close report is sent** (👍 counts still are): the question's text is never sent in its place.

## 4. Gap reports, after the response

Each request builds its own `SupportExecutor` with `keepAlive: (p) => ctx.waitUntil(p)`: one isolate serves many requests at once, so a module-level "current request" would hand one visitor's report to another's `waitUntil`. The site, the model and the corpus check are built once per isolate. Locally the report arrived 1.5 s after the response ended. The event stream itself is read to the end under `waitUntil` too, so a relay that disconnects mid-turn doesn't stop the turn from saving its context and sending its report. A turn cut off anyway leaves its task "working"; the next `GetTask` or `SubscribeToTask` fails it after 90 s (`settleStale`, in the object).

## 5. Secrets

```sh
wrangler secret put A2A_RELAY_TOKEN          # the same value as the relay's target credential
wrangler secret put ANTHROPIC_API_KEY
nxis keys create --scope content_gaps:report --site <site> --json | jq -j .api_key | wrangler secret put SUPPORT_GAP_KEY
openssl rand -hex 32 | wrangler secret put SUPPORT_TURN_REF_SECRET   # question keys and turn references; without it, no gap reports
```

`SUPPORT_MCP_ENDPOINT`, `SUPPORT_PROVISIONING_ENDPOINT`, `SUPPORT_TURN_RETENTION_DAYS` and the model names are `vars`. Never put a secret in `vars`: they are plain text in the config and the dashboard. Unset `A2A_RELAY_TOKEN`, nothing can call the agent; unset `ANTHROPIC_API_KEY`, the health path says unavailable.

## 6. Limits

| Limit | Here |
|---|---|
| CPU time | Free plan 10 ms per request, Paid 30 s by default. Waiting on the model, MCP and the Durable Object isn't CPU time. **Unconfirmed:** that a turn's JSON, grounding checks and SDK work stay under 10 ms. Use Paid |
| Subrequests | A turn makes up to about 25: two to four model calls, up to seven reads and the product and type queries, the Durable Object calls, the KV write and the report. **Unconfirmed:** the current per-plan numbers, and whether Durable Object calls count |
| `waitUntil` | 30 s after the response. A report takes one provisioning round trip |
| Durable Objects on Free | SQLite-backed classes only (`new_sqlite_classes`), as here. **Unconfirmed:** current Free-plan quotas |

## How to prove it

On `wrangler dev`, with `.dev.vars` filled in, before any deploy:

| Check | Expect |
|---|---|
| `curl localhost:8787/a2a/support/agent-card.json` | The card, `supportedInterfaces[0].url` on the origin requested |
| `curl localhost:8787/a2a/support/healthz` | `{"available":true}` with a key and a reachable MCP server |
| `POST /a2a/support` with no, a wrong, or a same-length wrong token | 403 |
| A 100 KB body | 413 |
| An unanswerable question through the relay | The not-found reply at once; the gap on the list a moment later, by its key; its wording with `wrangler kv key get --binding SUPPORT_TURNS "question:<question_key>" --local`, its turn with `"turn:<ref>"` |

Then SKILL.md step 7 on the deployed Worker, through the site's relay.
