---
name: action-binding
display_name: Action Binding
icon: arrows-right-left
source: NXISAI
description: >
  Route a site's Actions (bookings, quote requests, sign-ups) and the hosted
  agents that send requests to the user's own application, through a named
  connection: create or reuse the connection, bind the route, store its signing
  secret where a redeploy will still find it, and add a handler that checks the
  signature (references for Next.js, Netlify, Vercel, Cloudflare Workers,
  Express and Fastify). Also rotating that secret. Use when submissions should reach the
  user's backend rather than running on the page.
license: Apache-2.0
compatibility: >
  Any host. Needs a verified site, the nxis CLI (nxis, or npx -y
  @nxisai/cli@latest) 0.2.0 or later for connections, and an application the user can
  deploy. Runs in the project that receives the submissions.
metadata:
  author: nxisai
  version: 2.6
  type_group: _integration
allowed_tools:
  - nxis_mcp_settings
  - nxis_list_connections
  - nxis_create_connection
  - nxis_bind_connection
  - nxis_rotate_connection_secret
  - nxis_delete_connection
  - nxis_test_connection
  - nxis_bind_mcp_action
  - nxis_verify_site
  - nxis_site_tag
enabled: true
---

Send a site's Actions somewhere the user controls. An agent that books a table or requests a quote submits a payload. This skill decides where that payload lands, signs it, and makes sure the receiving application can prove it came from NxisAI.

Onboarding leaves Actions bound to the page that declares them. That needs no configuration and is right for most sites. This skill is for when it is not enough: the submission has to reach a booking system, a CRM or an internal queue.

## When this skill applies

Use this skill when **all** of the following are true:

- The site is verified, normally by **agentic-site-onboarding**
- The user wants submissions delivered to their own application rather than handled on the page, or wants a connection's secret rotated
- You are running in the project that will receive them, and the user can deploy it

Do not use this skill for:

- Turning Actions on in the first place. That is **agentic-site-onboarding**
- Putting Actions on the page as WebMCP tools. That is **site-tag-installation**
- Turning on a hosted agent. That is **hosted-agents**, which sends here for the receiver when the agent needs a connection
- A site that is not verified. Connections and routes are refused for one; see step 2
- Zapier or another external MCP server. That is a dashboard flow; see the table below

## Connections

A **connection** belongs to the site: a name, an https address on the user's servers, and one signing secret. Every route that sends there shares it:

- **A kind of Action**: `reserve`, `schedule`, `quote`, `ask`, `apply`, `buy`, `order`, `donate` or `pay`
- **`default`**: every Action without a route of its own
- **A hosted agent's own route**, such as `booking`, set by **hosted-agents** with `nxis_enable_agent` and `connection` on the local MCP server (`nxis agents enable <id> --connection <name>` on the CLI)

One secret per connection, not per route: rotating it affects everything that sends through it, and `nxis connections list` says what that is (`used_by.agents`, `used_by.action_types`). A connection marked `default` is where every route without its own goes.

| Route | Delivery | Configuration | Choose it when |
|---|---|---|---|
| The page (`--self-page`) | The page that declares the Action runs it | None. The default | The site already handles the form, or an on-page agent does |
| A connection (`--connection <name>`) | A signed POST to the connection's address | A connection, and its secret stored with the receiver | The submission must reach a server the user controls |
| A gateway (`--gateway`) | Into an external MCP server | OAuth, a chosen tool, pinned arguments | Zapier or a personal MCP server |

**This skill covers connections.** A gateway needs an OAuth connection and a tool picker that cannot be completed from here. The CLI points to the dashboard for it, and that is the right answer, not a failure to work around.

The address does **not** have to be on the site's own domain. Verification proves the user may speak for the site; where they route their own submissions is their business.

**Commands.** Use the CLI (`--json` on each). On the local MCP server (`nxis mcp serve`), the same operations are tools: `nxis_list_connections`, `nxis_create_connection` (`name`, `url`, `make_default`), `nxis_bind_connection` (`action`, `connection`, `supports_check`, and Booking's `availability_url`), `nxis_rotate_connection_secret` (`connection`), `nxis_delete_connection` (`connection`) and `nxis_test_connection` (`connection`, `action`, `turn_on_checks`). Each that changes something asks the user in a dialog first; don't ask it in the conversation too. On the remote MCP server, run the CLI.

| Exit | Means | Do |
|---|---|---|
| `0` | Done | Continue |
| `2` | Needs the user (`connection_not_found`, `connection_in_use`, `site_not_verified`, `confirmation_required`, `nothing_bound`) | Relay it and resolve it as below. **Never run the same command again unchanged** |
| `3` | Not authorized | `nxis login`, then run it again |
| `1` | Failed (`connection_name_taken`, `connections_unavailable`, `invalid_input`) | Report it as given |

## The pattern, in seven steps

### Step 1 — Read what is there now

Run `nxis mcp settings --json` (`nxis_mcp_settings`) and `nxis connections list --json` (`nxis_list_connections`) before proposing anything. Report in a sentence or two: whether Actions are on, where the default and each kind of Action go, the site's connections, and what uses each.

If a route already sends to a connection, **say so before changing it.** Someone with a working integration needs to hear that it is about to change. A route they have forgotten about is the most likely cause of a support question later.

### Step 2 — Confirm the site is verified

Connections and routes are refused for an unverified site (`site_not_verified`, exit 2), because routing a site's Actions is a claim to speak for its domain.

Do not surface that as an error. Run `nxis sites verify --check` (`nxis_verify_site`, `mode: check`). If the site is not verified:

- If the verification tag is missing, add it. You are in the project, so you can. Then tell the user it needs a deploy before verification will pass
- If the tag is present but unverified, run verification again once the deploy is live
- If neither is possible here, hand back to **agentic-site-onboarding** and stop

### Step 3 — Choose the connection, and what it receives

**Reuse before you create.** If a connection in the list already points at the user's application, offer it: one secret, already stored, serves every route.

**Otherwise ask for the address.** This must not be guessed. You may **suggest** one you can see (a route in the project, the deployment's domain, an existing handler), but the user names it. When you are about to build the receiver here (step 6), the suggestion is the site's verified host plus the route the host reference puts it at (`https://example.com/api/nxis/action`); show it and create the connection only on the user's yes. A destination invented by an agent sends a customer's booking to a URL nobody chose. Ask for a name too, 1 to 60 characters and unique on the site; the site's name or "Website" is usual.

Then ask **which routes** should send there: every Action (`default`), or only some kinds (`reserve`, `quote` …). Naming one leaves the rest as they are.

Create it with `nxis connections create --name "Website" --url https://… --json` (`nxis_create_connection`). `--default` (`make_default: true`) also makes it the site's default connection, so ask before passing it. `connection_name_taken` (exit 1) means pick another name, or reuse that connection.

**The answer carries `signing_secret`, once.** It is in no later output: not in `list`, not in an error, never in a `--verbose` trace. Everything in step 4 happens before you reply to the user.

### Step 4 — Store the secret before you say anything

A secret that reaches the conversation and nowhere else is gone when the window closes. Write it down first, then report.

**Check the ignore rules first.** Confirm `.env` is in `.gitignore`. If it is not, add it before writing. If the repository has ever tracked `.env`, say so and stop: a secret committed to history needs rotation, not another write on top.

Then, in this order:

1. **`.env`**: add `NXIS_ACTION_SECRET=<secret>`. If the project already names this value (an older `NXIS_WEBHOOK_SIGNING_SECRET`, say), keep its name; do not invent a second name for the same value
2. **`.env.example`**: add the name with an empty value, so the next person knows it is required
3. **The deployment's own environment**: Netlify, Vercel, Fly, Render, a CI secret. **This is the step that makes it survive a redeploy.** `.env` is usually local only; a deployed site reads its configuration from the platform. If you can set it with the platform's CLI, do. If you cannot, give the user the exact steps for their platform

Only then reply. Say where it was stored, and that the application needs a redeploy before deliveries will verify.

Do not print the secret back for confirmation. It is in the files; repeating it puts it in the transcript as well.

### Step 5 — Bind the routes

For each route from step 3:

```
nxis actions bind <action|default> --connection "Website" --json
```

(`nxis_bind_connection` with `action` and `connection`.) The answer has the `binding` (`connection_name`, `url`, `method`), the `webhook_host` and the site's `connections` as they now are. `connection_not_found` (exit 2) lists the names there are: ask which was meant.

**Route options.** `--supports-check` (or `--supports-check=false`) goes with any route: it says the receiver answers availability checks, so the hosted agents check before they send (Booking offers open times and holds, Quote checks the service area). For `booking`, `schedule` or `reserve`, `--availability-url <url>` is where free times are read. **The availability URL must be on the connection's host**; one on another host is not used. Left out, each stays as it is; an empty `--availability-url ""` clears it. An older CLI takes `--supports-check` only on `booking`, `schedule` and `reserve`: on one that refuses it for `quote`, say so, and use `nxis connections test <name> --turn-on-checks` instead (below).

Routes take effect at once, and turn the site's Actions on if they were never set. If Actions were turned off, `nxis actions on` turns them back on, on the user's yes.

### Step 6 — Add the handler

A route at the connection's address that verifies the signature before trusting the body. Every request, from the site's MCP server and from hosted agents alike, is a POST with a JSON body and:

```
X-Nxis-Signature: t=<unix-seconds>,v1=<hex>
```

where `v1` is the lowercase hex of `HMAC-SHA256(secret, "<t>.<raw body>")`, keyed with the connection's secret as UTF-8 text.

**Two things make a handler reject every delivery, and both look like the feature is broken:**

- **The HMAC covers the raw bytes.** A framework that parses JSON before your handler sees it gives you a re-serialized body whose signature never matches. Configure raw-body access for this route
- **Compare in constant time.** A plain `===` on the hex leaks the secret a byte at a time

**Start from the host reference for the project's framework** (below): copy `receiver.ts`, `submissions.ts`, `bookings.ts` and the one host file, and fit them to the project's layout. Otherwise write it in the project's own framework and conventions. The shape:

```js
// Raw body, not the parsed object.
const raw = await readRawBody(req);
const header = req.headers['x-nxis-signature'] ?? '';
const t = header.match(/t=(\d+)/)?.[1];
const v1 = header.match(/v1=([a-f0-9]+)/)?.[1];
if (!t || !v1) return reject(400);

// Replay protection: refuse anything outside a freshness window.
if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return reject(400);

// The current secret, and during a rotation the one before it (see "Rotating the secret").
const secrets = [process.env.NXIS_ACTION_SECRET, process.env.NXIS_ACTION_SECRET_PREVIOUS].filter(Boolean);
const given = Buffer.from(v1, 'hex');
const valid = secrets.some((secret) => {
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
});
if (!valid) return reject(401);

// Verified. Now parse.
const submission = JSON.parse(raw);
```

**What to answer.**

- **A submission:** a 2xx with a JSON body that carries the reference, as `confirmation_id` (or `reference`, `booking_id`, `id`). A 2xx without one is not taken as a confirmation: the visitor's agent is told it failed
- **A slot that is taken:** `409`, with any `alternatives` in the JSON body, so the agent offers another time instead of retrying
- **A check** (a route with check support on, and the hosted agents before they send): the request carries `X-Nxis-Mode: check` and `"nxis:mode": "check"` in the signed body. Answer `200` with `{"available": true|false}` and what the kind of request adds (below), and **commit nothing**. With an availability URL, checks go there; otherwise to the connection's address

#### Check answers, availability and holds

**Availability and holds live in the business's receiver.** NxisAI has no calendar of its own: the agents show what the check answers, and show less when it answers less.

**Booking check:**

```json
{
  "available": true,
  "windows": [{ "start": "2026-12-01T08:00:00-06:00", "end": "2026-12-01T12:00:00-06:00", "open": 2 }],
  "hold": { "token": "…", "expires_at": "2026-12-01T13:05:00.000Z" },
  "alternatives": []
}
```

- `windows`: the windows asked about, or the next open ones when the check names none, each with `start` and `end` (ISO instants with an offset) and `open`, the seats still free. A check for a date lists that day's windows, full ones with `open: 0`
- `hold`: only for a check that names one window with a seat free, never for a list. It keeps that seat until `expires_at` (a few minutes) while the visitor reads the summary and says yes. A check that sends back its own live `hold_token` for the same window gets the same hold, not a second one
- When the window isn't open (full, started, too far ahead, not offered): `"available": false`, a `reason`, and the next open windows in `windows` and in `alternatives` (older readers read that)

**A booking commit** may carry `hold_token`. The receiver honors it until `expires_at`: the held seat becomes the booking. An expired hold is refused with `409` and `"code": "hold_expired"`, a token it never issued (or one used already, or for another window than the body names) with `409` and `"code": "hold_unknown"`, each with the windows open instead in `alternatives`. A commit without a hold still books when the window has a free seat; when it hasn't, `409` with `"code": "taken"` and the next open windows. Held seats count as taken until they expire. The confirmation carries the window's `start` and `end`.

**Without `open` or `hold`** the agents still work: they show windows without counts and no countdown, and a commit may come back taken with alternatives.

**Quote check:** `{"available": true|false}`, optionally `service_area` (whether the business serves the address given) and `fields` (what it still needs). The estimate never comes from the receiver: agents quote from the site's published offers.

The host references answer all of this, and [`bookings.ts`](references/hosts/bookings.ts) is the source of truth for a booking receiver, whether it is copied or the project's own: it keeps the windows, seats and holds, from `calendar` in `submissions.ts` (weekly hours, time zone, seats per window, hold length), over a pluggable store whose every write is conditional (only if new, only if unchanged), so two visitors can't both get the last seat.

Answer fast. A visitor's agent is waiting on the response; queue anything slow rather than holding the request open.

**Retries carry an `Idempotency-Key` header.** Commit at most once per key, and answer a repeat with the first answer (the same reference), so a retried booking is not booked twice. Pass the key on to wherever the submission lands, so that place can refuse a duplicate too.

#### Host references

Each is a working receiver: the raw body read as bytes, the signature verified exactly as NxisAI signs it (above), a 300-second freshness window, a constant-time comparison (`crypto.subtle.verify`), the current and previous secret, a check answered without side effects, and a commit deduplicated on `Idempotency-Key`. They share [`receiver.ts`](references/hosts/receiver.ts) (Web Crypto only, so it runs on every host below), [`bookings.ts`](references/hosts/bookings.ts) (availability and holds) and [`submissions.ts`](references/hosts/submissions.ts), whose `deliver()` is the **TODO**: where a submission is stored or forwarded. Until it is written the receiver answers `501` and confirms nothing. Ask the user where submissions should go, starting with what the project already uses (an email to the inbox that takes them today, the webhook the site's form posts to, a database table) and write `deliver()` for that. For a receiver that takes bookings, also set `calendar` in `submissions.ts` from the business's hours and capacity, asking the user: availability and holds are on by default.

| Project | Reference | Route, so the address is `https://<host>/api/nxis/action` | Local, before NxisAI can reach it |
|---|---|---|---|
| Next.js, App Router | [`nextjs.ts`](references/hosts/nextjs.ts) | `app/api/nxis/action/route.ts` | `next dev`; a tunnel or a preview deploy |
| Next.js with `output: "export"`, or any static site | The host's function below | A static export has no server, so a route handler is never deployed | |
| Netlify | [`netlify.ts`](references/hosts/netlify.ts) (Functions v2) | `netlify/functions/nxis-action.mts`, `config.path` | `netlify dev` serves functions; a framework's own dev server does not |
| Vercel (not Next.js) | [`vercel.ts`](references/hosts/vercel.ts) | `api/nxis/action.ts` | `vercel dev`; a preview behind Vercel Authentication refuses the call |
| Cloudflare Workers or Pages | [`cloudflare.ts`](references/hosts/cloudflare.ts) | A route on the site's zone, or a Pages Function | `wrangler dev`, secret in `.dev.vars` |
| Express or Fastify | [`node.ts`](references/hosts/node.ts) | `app.use(nxisActionRouter())` before `express.json()`; `app.register(nxisActionPlugin)` | The server's dev command |

Each file's header says where it goes, how to detect the host, where its secret is read from locally and in production, and what its dedupe and its seats need: an in-memory store is enough for one long-running Node server, while on a serverless host each request may land on a fresh instance, so the file says which shared store to use and marks it **TODO** (Netlify Blobs with `onlyIfNew` and `onlyIfMatch`, Redis, a Durable Object or D1). [`hosts.test.ts`](references/hosts/hosts.test.ts) (vitest) runs every one of them in process: a correctly signed call is delivered once, a tampered body, a re-serialized body, the wrong secret, no signature, and a timestamp outside the window are refused with `401`, a check calls nothing that commits, a repeated key is delivered once, and a body over the cap is refused; for bookings, open counts, a hold issued, honored and expired, an unknown hold, a commit without a hold, and a taken window with alternatives. Copy it with the files and run it before the first deploy.

**Make the address reachable before testing it.** NxisAI calls the connection's address from the internet: `localhost` is never reachable. Test on a deploy (a preview is fine), or behind an https tunnel to a local server that serves the route. Plain `next dev` does not serve a Netlify function; `netlify dev` does. A connection's address can't be changed in place, so a tunnel gets its own connection (say "Local"), deleted when you are done, and production its own.

**Test it with a signed check.** `nxis_test_connection` with `connection` on the local MCP server, or `nxis connections test <name|id> --json` on a CLI that has it, sends a signed check call to the connection and reports the verdict: `signature_rejected` means the receiver reads a different secret or verifies a parsed body; `unreachable` means the address isn't deployed, the tunnel is down, or the tunnel is up and the server behind it isn't reachable (a newer CLI names the answerer; the body may be the tunnel's error page). Before suggesting a fix for `unreachable` or `bad_response`, find where the server really runs, never from a dev script's default port alone, and ask before restarting anything the user runs: see [When a tunnel or host answers with an error](../agentic-site-onboarding/SKILL.md#when-a-tunnel-or-host-answers-with-an-error) in **agentic-site-onboarding**. On the CLI, check `nxis --help` lists `connections test` first. Without it there is no way to sign a call from here, since the secret is never shown: say so, have the user deploy or start the tunnel, and tell them the first real call shows whether it works.

#### Turn check support on

**A receiver that answers checks needs check support on its routes**, or the agents never send it a check: Booking takes visit requests to confirm instead of offering open times and holds, and Quote skips the service-area check. The test says which applies:

- `answers_checks: true`: the receiver answered as a check (JSON with a boolean `available`). For a booking check, `returned_windows` says it listed open times and `returned_hold` that it held one (a hold comes only when the check names one window, so `false` is normal for the test)
- `answers_checks: false`: it answered 2xx, but not as a check. Agents send without checking. When the receiver is in this project, give it check mode as [`receiver.ts`](references/hosts/receiver.ts) does
- `check_support_off`: the routes on the connection (`default`, `QuoteAction`, `ScheduleAction` …) that have it off

**After building a receiver with check mode** (every host reference here answers checks), and once the agents or routes that use the connection are set up, test with `turn_on_checks: true` (`nxis connections test <name> --turn-on-checks --json`). It turns check support on for each route with it off, and `check_support_turned_on` lists them. Then confirm `answers_checks` is `true` and `check_support_off` is empty, and for Booking that `returned_windows` is `true` (with `--action booking`); say what visitors now get. When a booking receiver in this project answers `returned_windows: false`, its check doesn't list a day's windows: bring its check and commit up to [`bookings.ts`](references/hosts/bookings.ts) and test again. Its holds can't show in this test, whose check names a date alone, so run the booking cases in [`hosts.test.ts`](references/hosts/hosts.test.ts) for them. A connection tested before its agents are enabled needs nothing more for them: routes made after a passing test start with check support on. Still test again after the enable, which shows it.

When the user didn't ask you to set the site up, put the change to them first: "Your receiver answers availability checks, but check support is off for quote requests and bookings. Turn it on?" On a terminal, `nxis connections test` asks this itself.

**On a CLI without `--turn-on-checks`** (`nxis connections test --help` doesn't list it), set it per route: `nxis actions bind booking --connection <name> --supports-check --json`, and for Quote `nxis actions bind quote --connection <name> --supports-check --json` on a CLI that takes it there. Say which routes you couldn't set.

### Step 7 — Confirm, honestly

Run `nxis connections list --json` and `nxis mcp settings --json` again and show the routes that are now live.

Then say plainly what is and is not working yet:

- The routes are live **now**: NxisAI will start signing and delivering
- The handler is **not** live until the user deploys, and has not been tested until `nxis connections test` passes against the deployed (or tunneled) address
- Whether agents check first: check support on (the test's `check_support_off` empty with `answers_checks: true`), or off and why
- Until then deliveries fail, and that is expected rather than a misconfiguration

Never imply an endpoint is working when it has only been written to disk.

## Rotating the secret

Rotate only when the user asks, or when the secret has leaked (committed, pasted, logged). Rotating never recovers a lost secret: fix the failed write instead.

1. **Say what breaks.** `nxis connections rotate <name|id>` issues a new secret, and **the old one stops working for everything that uses the connection**: every route and every hosted agent in `used_by`. Until the receiver has the new one, their requests fail verification. Name them to the user, and ask
2. **Rotate.** Without a terminal it stops with `confirmation_required` (exit 2) until `--yes`, which you pass only on the user's yes. The answer carries the new `signing_secret`, once (`nxis_rotate_connection_secret` on the local server)
3. **Store it as in step 4**, in `.env` and the deployment's environment, replacing the old value. If the handler accepts a previous secret, move the old value to `NXIS_ACTION_SECRET_PREVIOUS` first: for a few minutes after a rotation, some requests can still arrive signed with the old one
4. **Redeploy**, and tell the user that requests fail between the rotation and the deploy
5. **Remove the previous secret** once the deploy has been live for a while, and redeploy again

## Handling something that cannot be recovered

**The secret is shown once.** If it is lost, the fix is rotation, not retrieval, and deliveries fail between rotating and redeploying.

**Never commit it.** Files and the platform's environment only. Not the repository, not the transcript, not a comment on a ticket.

**Deleting a connection.** `nxis connections delete <name|id>` asks first (`--yes` on the user's yes) and is refused with `connection_in_use` (exit 2) while any route or hosted agent sends through it; `used_by.agents` names them. Bind them elsewhere first, on the user's word.

## An older CLI, or a route bound before connections

A CLI before 0.2.0 has no `nxis connections`; offer `nxis update`. `nxis actions bind <action|default> --webhook <url>` still works and goes through connections: it reuses the connection with that address, keeping its secret, or creates one named after the host and shows its secret once (`connection_created: true`). Routes bound before connections existed were moved onto connections with their address and secret unchanged, so a receiver that verifies today needs no change.

## When to stop and hand back

- **The site is not verified and cannot be from here**: **agentic-site-onboarding**
- **The user wants Zapier or an external MCP server**: the dashboard
- **`.env` is tracked in git**: say so, stop, and let the user decide whether to rotate and scrub history
- **You cannot reach the deployment's environment settings**: write the local files, then give the user the exact steps rather than leaving it half done and implying it works

## Related skills

- **agentic-site-onboarding** runs before this. It verifies the site and turns Actions on, bound to the page. Its step 9 routes Actions through a connection in short; this skill is the full version, with the receiver
- **hosted-agents** turns on the agents NxisAI hosts. An agent that sends requests to the business uses a connection from this skill, and the same receiver verifies it
- **site-tag-installation** is the other destination for an Action: onto the page itself as a WebMCP tool. Independent of this skill; a site can have both
- **on-page-agent** is the agent that calls page-bound Actions. A connection route changes the server-side route only
- **The host's own skills**, when the project has them installed, set deployment environment variables and deploy

This skill owns **where a submission lands**: the connection, the routes, the secret, and the handler that verifies it. It does not generate Actions, change the site's data, turn on agents, or deploy.

## References

| File | What |
|---|---|
| `references/hosts/receiver.ts` | The host-neutral receiver: signature, freshness window, check or commit, `Idempotency-Key` |
| `references/hosts/submissions.ts` | `deliver()` and `check()`: the TODO for where submissions go; `calendar`, the booking hours and seats |
| `references/hosts/bookings.ts` | Booking availability and holds: windows with `open` counts, a hold a commit honors until it expires, a taken window with alternatives, the store interface |
| `references/hosts/nextjs.ts`, `netlify.ts`, `vercel.ts`, `cloudflare.ts`, `node.ts` | The route or function for each host |
| `references/hosts/hosts.test.ts` | Every host, signed calls in process (vitest) |

## Tool reference

| CLI | MCP tool (local server) | Purpose |
|---|---|---|
| `nxis mcp settings` | `nxis_mcp_settings` | The current routes, before and after a change. Never a secret |
| `nxis connections list` | `nxis_list_connections` | Each connection's name, address, `secret_preview`, `is_default` and `used_by` |
| `nxis connections create --name … --url … [--default]` | `nxis_create_connection` | A new connection; `signing_secret` once |
| `nxis actions bind <action\|default\|booking> --connection <name\|id> [--supports-check[=false]] [--availability-url …]` | `nxis_bind_connection` | Send a route through a connection; `--supports-check` on any route, `--availability-url` Booking only |
| `nxis actions bind <action\|default> --self-page` | `nxis_bind_mcp_action` | Send a route back to the page |
| `nxis connections rotate <name\|id> [--yes]` | `nxis_rotate_connection_secret` | A new secret; the old one stops at once; `signing_secret` once |
| `nxis connections test <name\|id> [--turn-on-checks]` | `nxis_test_connection` (`turn_on_checks`) | A signed check call to the receiver, its verdict, whether it answers checks (`answers_checks`, `check_support_off`), and with the flag, check support turned on. Newer CLIs |
| `nxis connections delete <name\|id> [--yes]` | `nxis_delete_connection` | Delete one that nothing uses |
| `nxis actions on` | `nxis_bind_mcp_action` with only `enabled: true` | Turn the site's Actions back on, keeping every route |
| `nxis sites verify --check` | `nxis_verify_site` (`mode: check`) | Confirm the site is verified, which routing requires |
| `nxis sites tag status` | `nxis_site_tag` | Only when verification is missing and the tag has to be added first |
