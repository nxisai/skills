---
name: quote-agent
display_name: Quote Agent
icon: 🧾
source: NXISAI
description: >
  Give a site that runs @nxisai/agent-harness a conversational Quote Agent
  over A2A, and hand quote and estimate requests to it instead of the page's
  quote form: typed requests, result-card CTAs and NxisAI app links alike.
  It asks one question a turn, validates server-side, sends only on an
  explicit yes, submits once to the site's existing quote sink, and hands
  back the sink's reference. Use when a site with a quote form should take
  quotes in conversation; the form stays the fallback.
license: Apache-2.0
compatibility: >
  Needs @nxisai/agent-harness 0.12.0 or later, the agent-handoff relay, and a
  host that runs server code. Profiles: vite (Node; verified on a Vite dev
  server behind a tunnel, production Node unconfirmed); netlify (draft);
  docker (verified locally with a scripted model, deployment a draft);
  cloudflare (draft; verified locally on wrangler dev, not deployed); lambda
  (draft; verified on LocalStack, not deployed to AWS); cloudrun
  (draft; verified locally against the Firestore emulator, never deployed).
  Other hosts: asks five questions.
metadata:
  author: nxisai
  version: 1.0
  type_group: _integration
  harness_min: 0.12.0
  submit_policy: LEAD_GEN
allowed_tools:
  - nxis_get
  - nxis_mcp_settings
enabled: true
---

Put a Quote Agent behind the site's on-page agent: an A2A agent on the site's own origin that takes a quote request in conversation, confirms it with the visitor, sends it exactly as the site's quote form would, and hands back the reference — the way a booking agent takes a booking. The harness does the routing: the handoff target declares `takes: ['quote_form']`, and while the agent is available every road to the quote form leads to it instead.

The harness writes the client and the routing (`takes`). The **agent-handoff** skill writes the relay. This skill writes the agent, its adapter to the site, and the two lines of page config that connect them. The harness's contract is [docs/handoff.md](https://github.com/nxisai/agent-harness/blob/main/docs/handoff.md), "Targets that take a form" and "Writing a target".

## When this skill applies

Use this skill when **all** of the following are true:

- The site runs `@nxisai/agent-harness` **0.12.0 or later** (normally set up in **on-page-agent**). `takes` does not exist before 0.12.0
- The site has a quote, estimate or request-a-callback form that the site tag registers as a tool, and an existing place that form's submissions go (its **sink**)
- The handoff relay from **agent-handoff** is in place, or will be put in place first
- The host runs server code, and the user can deploy it and hold a model API key server-side

Do not use this skill for:

- **Submitting a quote from an outside agent** (Claude, ChatGPT through the NxisAI app) → **lead-funnel-quote**. That skill links into this agent when the form runs on the business's own page
- **Bookings with a slot** → **booking-agent** (the same pattern, with the site's calendar), or **lead-funnel-reservation** from outside the site
- **Applications** with regulated personal data → **lead-funnel-application**
- **A site whose form should stay the only way to quote** — nothing to do; the harness already fills forms
- **The relay itself, or a person at a desk** → **agent-handoff**

## What gets built

```
visitor ⇄ on-page agent ──handoff (takes: quote_form)──▶ relay ──A2A──▶ Quote Agent ──▶ the form's sink
           │  "Get a quote" text, card CTA,                (agent-        │ one model call a turn,  (webhook, app DB,
           │  ?nxis_handoff= link, a form call             handoff)       │ rules around it          or nxis_action)
           └─ quote away: the form, as before                             └─ hand-back: resolved + reference
```

- **The core** — `references/agent-core.ts`, copied unchanged: the executor, its rules, the Claude adapter, the Agent Card and the endpoint. Site-neutral
- **The site adapter** — a `QuoteSite` the project writes (`references/example-site.ts` is a starting point): who the quote is from, the fields, what the model should know, the sink
- **The field spec** — one JSON file the page's form and the adapter both read, so they cannot drift
- **The host file** — mounts the endpoint and card, and keeps tasks where the host needs them (`references/hosts/`). On Docker, a container of its own: server, Redis store, Dockerfile and compose files. On Cloud Run, the same container with Firestore for tasks, progress and the claim. On Cloudflare, a Worker with a Durable Object per task. On Lambda, a handler with DynamoDB
- **The page config** — the relay target `quote`, the page target with `takes`, and two prompt lines (`references/page-config.ts`)

## The host

Find the host from the project: server-side Vite plugins (`configureServer`) → vite; `netlify.toml` → netlify; a `Dockerfile` or `compose.yaml`, or a static site whose owner runs a server or VM → docker; `wrangler.toml` or `wrangler.jsonc` → cloudflare; a SAM `template.yaml`, `serverless.yml` or a CDK app, or a site on CloudFront → lambda; a `Dockerfile` deployed with `gcloud run deploy`, a `firebase.json` with `"run"` rewrites, or a Terraform `google_cloud_run_v2_service` → cloudrun. Five things differ between hosts. Answer them from the host's profile in `references/hosts/` when one exists, and ask the user when none does:

| Question | Why it matters |
|---|---|
| Where does server code live, and what does it run on locally? | Where the endpoint goes, and the origin the card points at |
| Where do tasks and progress live? | The agent's state between turns: the summary awaiting a yes, the submitted flag. Memory works on one long-lived process. With many instances (serverless), a store every request sees — or the visitor's "yes" lands on an instance that never showed the summary |
| Does the store have a conditional write? | The single-submit guarantee: only the first claim on a task may send. Without one, read-then-write, and say so |
| Where do secrets live? | The model key, the relay's credential, the sink's signing secret. Never the page, never a public variable |
| How long may one response take? | One model call a turn (2–4 s) must fit. Where turns can be cut off, fail a task left "working" on its next read |

Profiles: [vite](references/hosts/vite.ts) — a Node server as Vite plugins — is verified on a dev server behind a tunnel (the listings example, every check in step 7); a production Node deployment is unconfirmed. [netlify](references/hosts/netlify.ts) is a **draft**: its pieces are Copperline's booking agent, verified in production, with this core in place of the booking executor — the Quote Agent has not run there end to end. [docker](references/hosts/docker.md) — the agent as a container of its own, code in `references/hosts/docker/` — is **verified locally with a scripted model**: one replica, two replicas sharing Redis with the submit claim under a simultaneous yes, Redis down, Caddy in front, the relay core calling it. A real model in the container and a deployment behind TLS are unconfirmed. [cloudflare](references/hosts/cloudflare.md) — a Worker with one Durable Object per task, holding the task, the progress and the claim — is a **draft, verified locally** under `wrangler dev` (a scripted model API, a stub sink): auth, body cap, two concurrent yeses sending once, and a relay that disconnects mid-send. It has not been deployed. [lambda](references/hosts/lambda.md) — a Node 22 function behind a Function URL, routed through the site's CloudFront, with tasks, progress and the claim in DynamoDB (a conditional put) and secrets in SSM — is a **draft, verified on LocalStack** 4.2.1: the SAM template deployed through LocalStack's CloudFormation, the Function URL driven over HTTP with secrets from SSM, a stub model API and a stub sink — auth, body cap, a conversation to one signed submission, and two concurrent yeses on two execution environments sending once, both replies carrying the reference. Nothing has been deployed to AWS; IAM enforcement, CloudFront and a real model are unconfirmed. [cloudrun](references/hosts/cloudrun.md) — the Docker image on Google Cloud Run, with tasks, progress and the submit claim in Firestore, code in `references/hosts/cloudrun/` — is a **draft, verified locally against the Firestore emulator with a scripted model**: two instances sharing the emulator, the same yes on both at once, the emulator stopped and restarted, and every write landing before the response ends. Nothing has run on Google Cloud. Say which to the user.

Reach for Docker when the site's host serves static files only and the owner runs a server or VM, when one Quote Agent should serve several sites, or when the same image should run locally and deployed. It is the user's infrastructure, so offer it; don't choose it for them.

Reach for Cloud Run when the user wants the container without a server to run it, already uses Google Cloud, or has a site behind a Google Cloud load balancer or Firebase Hosting. On a budget, it scales to zero: Firestore and request-based CPU cost nothing while no one asks for a quote. Memorystore, the alternative store, has a monthly floor.

## The pattern, in seven steps

### Step 1 — Find the quote form, its action, and its fields

Check `@nxisai/agent-harness` is 0.12.0 or later and the agent-handoff relay answers `GET /api/handoff`. If not, upgrade, or run **agent-handoff** first.

Then, from the project and the page:

- **The QuoteAction.** In the page's JSON-LD, the `potentialAction` of `@type` `QuoteAction` (or `AskAction` for a callback form): its `@id`, its `name`, and `nxis:targetKind`. `nxis_get` on the `@id` returns its `nxis:input` specs when they aren't inline. `selfPage` means the form posts from the page; `webhook` or `gateway` means it is bound server-side
- **The tool name.** The action's `name`, lower-cased, with spaces and dashes as `_` and anything else as `_`: "Quote Form" → `quote_form`. Confirm it: before changing anything, ask the on-page agent for a quote and read which tool its confirm card is for. A directory's site-wide copy is `<name>_anywhere`; `takes` covers both
- **The fields.** Every input the form posts: name, label, required, and for a select its option values and labels. Hidden inputs too (a business name on a directory page), and where their values come from
- **The sink.** Where the form's submission goes — a webhook, a server handler that saves to the site's database, or the action's binding — and what it answers on success

Ask the user what counts as an emergency in their trade (a burst pipe, water through the ceiling, no heat in winter), and the phone number to send those visitors to.

### Step 2 — Write the field spec, shared with the form

One JSON file: the hidden fields and their sources, then each field with `name`, `label`, `kind` (`text`, `email`, `phone`, `choice`, `longtext`), `required`, and for a choice its `options` as `{ value, label }` (or a marker like `"business.services"` that the adapter expands per business). `references/quote-form.example.json` is the shape.

Make the form and the spec agree, by construction where possible:

- A form rendered from a template or component: render its inputs and options from the spec
- A hand-written form: add a test that reads the page's form and compares names, required flags and option values to the spec

The agent posts **exactly** what the form posts — same keys, same order, same treatment of empty values (a `FormData` form sends an empty text input as `""` and leaves out a select left on its placeholder). The sink should not be able to tell them apart.

### Step 3 — Write the site adapter

Copy `references/agent-core.ts` into the project unchanged, beside the host's server code. Write the adapter, a `QuoteSite`, from `references/example-site.ts`:

| Member | What it answers |
|---|---|
| `agentName`, `role`, `providerNoun` | "Ridgeline Quotes", "sends quote requests to Ridgeline Roofing", "business". The name matches the card and the relay label |
| `providerAt(page)` | The business the visitor was on, from the envelope's `page`: its `entity` (`@id`) first, then its path. **One business:** return it for every page |
| `match(text)` | Businesses the visitor's words name, best first; a tie returns all of them and the agent asks which. Match on whole names and on name words no other business shares and no job uses. **One business:** `[]` |
| `fields(provider)` | The spec, as `QuoteField[]`, with per-business options expanded |
| `facts(provider)` | Two or three sentences for the model: what the business is, what it offers, where, its phone |
| `guidance` | Prompt lines about this form's fields: what to ask about if unclear, what's optional ("offer a phone number once — 'no' is an answer") |
| `emergency` | `pattern` (on lower-cased text), `examples` for the model, `values` that mean "right now" (`{ timeline: ['emergency'] }`), a safety `advice` line, and `noProvider` — who to call when no business is settled yet |
| `fallback(provider)` | Where the visitor can still send it themselves: "the quote form on their page" |
| `submit(provider, values)` | Send it — once — and return `{ ok, reference? }` |

**The sink** decides `submit`:

| The form's submissions go to | `submit` |
|---|---|
| A webhook — the site's own, or the user's application via **action-binding** | POST the identical payload to a URL fixed server-side, signed: `X-Nxis-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, with the binding's signing secret. A sink that accepts unsigned posts only from same-origin browsers will refuse an unsigned server post — sign it |
| A server handler that saves to the site's database | Call the same function the handler calls (Copperline's booking agent calls the `/book` form's `saveSubmission`), so the office is notified the same way and the reference works wherever references are looked up |
| A server-side binding (`nxis:targetKind` `webhook` or `gateway`) | `nxis_action` on the Site MCP with an API key, server-side. **Draft, unverified.** A `selfPage` action cannot run this way |
| A third-party form service the browser posts to | POST the same payload to the same endpoint, server-side — if the service accepts a server's post. One that needs a browser token or a CAPTCHA can't take the agent's; say so to the user and stop, or move the form to a sink the site controls first |

If `references/` is not available: the core is one model decision per turn, wrapped in the rules under "Security and consent" below, plus an endpoint built on `@a2a-js/sdk` (`DefaultRequestHandler`, `JsonRpcTransportHandler`) that answers `TASK_STATE_INPUT_REQUIRED` to ask and `TASK_STATE_COMPLETED` with a `handback` part to finish. Build it to those rules, or fetch the reference from the nxisai/skills repository.

### Step 4 — Get consent, then mount the endpoint and card

Put this to the user, and **wait for an explicit yes**:

> The Quote Agent sends each quote conversation — what the visitor types, including their name, email, phone and the job — to Anthropic's API to decide the next question. It runs on your API key, billed per turn. The request itself goes only where your quote form sends it today. OK?

Consent to an on-page agent, or to the handoff relay, is not consent to this.

Then, from the host profile:

1. Mount `POST /a2a/quote` (the A2A endpoint, **relay only**) and `GET /a2a/quote/agent-card.json`. Serve the card at `/.well-known/agent-card.json` too only if no other agent on the site claims it
2. Keep tasks (the SDK's `TaskStore`) and progress (the core's `ProgressStore`) where the profile says — memory on one process, the host's store otherwise, with `claim` on a conditional write
3. The model: `claudeModel(new Anthropic({ apiKey }), model)` with the key from a server-side secret and `QUOTE_MODEL` defaulting to a current Sonnet. It offers three tools — `ask_visitor` (one question), `ready` (the values, typed from the field spec), `hand_back` — with `tool_choice: auto`: Claude Sonnet 5.5, Opus 5.5 and Fable 5.1 answer a forced tool choice with a 400, so a plain-text reply is taken as the question. Without a key, the model is `null` and the relay must list the agent as unavailable
4. The relay's credential: a bearer token the relay sends and the endpoint checks — fresh per start when both run in one process, a shared secret (`A2A_RELAY_TOKEN`) when they don't. No public default
5. Fill in the card's words (`quoteAgentCard`): name, description, what it collects, two example requests

**On Docker**, the agent is its own service, and the steps above map to it like this:

- **The code.** `hosts/docker/server.ts` serves the endpoint, the cards and `/healthz` on `node:http`. Copy it into a `quote-agent/` directory beside the site, along with the rest of `hosts/docker/`: `redis-store.ts`, the Dockerfile, both compose files, `.dockerignore`, `.env.example` and `package.json`
- **The routes.** The site's reverse proxy routes the two card paths and `/a2a/quote` to `127.0.0.1:4120`, never `/healthz`
- **The card.** Built from `PUBLIC_ORIGIN`
- **The secrets.** In `.env.local`, gitignored. `A2A_RELAY_TOKEN` is required, with no default
- **Storage.** One replica keeps tasks in memory. For more, add `compose.replicas.yaml`: Redis for tasks and progress, and the claim as `SET NX`. With Redis down, it refuses to submit rather than fall back
- **The relay target.** Its `endpoint` is the container's absolute URL, and its `availability` reads the container's `/healthz` directly

The profile has the details.

**On Cloud Run**, the agent is the Docker container, run by Cloud Run, with Firestore for state:

- **The code.** `hosts/cloudrun/server.ts` and `firestore-store.ts`, with the Docker profile's `redis-store.ts`, Dockerfile and `.dockerignore`, and `hosts/cloudrun/package.json` and `.gcloudignore`. Build for `linux/amd64`
- **CPU only during a request.** The response ends after the turn's last event. By then the task, the progress, the claim and the sink call are all done, so throttling after the response cuts off nothing the next turn needs. Keep request-based billing
- **The routes.** Through the site's front door: a load balancer's serverless NEG, or Firebase Hosting rewrites, for `/a2a/quote`, `/a2a/quote/*` and (if unclaimed) `/.well-known/agent-card.json`. Never `/healthz`. Or the service's own origin. With a load balancer, `--ingress=internal-and-cloud-load-balancing`
- **The relay's credential.** `--no-invoker-iam-check`: the relay's bearer token travels in `Authorization`, which Cloud Run's IAM check would claim for a Google ID token, and the cards must stay public. The server refuses anything without the token
- **Storage.** Firestore: `quote-tasks`, `quote-progress` and `quote-sent` (the claim, by `create()`), each with an `expireAt` TTL policy. With Firestore unreachable, it refuses rather than sends. Memorystore only if the project already runs one
- **The secrets.** Secret Manager, `--set-secrets`, and a dedicated runtime service account: `roles/datastore.user` on the database, `roles/secretmanager.secretAccessor` on the three secrets only
- **Scale.** `--min-instances=0` (a cold start may hand the first visitor after a quiet spell the form), `--max-instances=3` as a spending ceiling, `--concurrency=40`, `--timeout=60`, a startup probe on `/healthz`
- **The relay target.** Its `endpoint` is `https://<site>/a2a/quote`. Its `availability` reads `https://<site>/a2a/quote/healthz` with the token

The profile has the deploy recipe (`gcloud`, or `hosts/cloudrun/quote-agent.tf`). It is the user's to run.

**On Cloudflare**, the profile's `QuoteTask` Durable Object holds the task, the progress and the claim: bind it and add the `new_sqlite_classes` migration from `hosts/cloudflare/wrangler.jsonc`, which also turns on `nodejs_compat`. Set the key and the relay token with `wrangler secret put`, never as `vars`. If the relay is a Worker too, give it a service binding to the agent and pass the binding's `fetch` to the relay.

**On Lambda**, the card's origin is `PUBLIC_ORIGIN`, never the request's Host (behind CloudFront that is the Function URL). The secrets are SSM SecureStrings the user creates themselves, since CloudFormation can't. `hosts/lambda/template.yaml` (SAM) creates the function, its URL, the DynamoDB table and a policy scoped to them.

### Step 5 — Register the target, with `takes`, and the prompt lines

**In the relay** (the agent-handoff adapter), one more target:

```ts
{ name: 'quote', kind: 'agent', label: 'Ridgeline Quotes',
  description: 'an agent that takes a quote or estimate request in conversation, confirms it with the visitor, sends it, and returns a quote reference',
  endpoint: '/a2a/quote', credential: () => ({ Authorization: `Bearer ${token}` }),
  transcript: false, push: false,
  availability: async () => ({ available: modelConfigured }) }
```

`availability` is what makes the form the fallback: no model, and the relay lists `quote` as unavailable.

**On the page**, beside the site's other targets:

```ts
agent.handoff = {
  relay: '/api/handoff',
  targets: {
    quote: { kind: 'agent', label: 'Ridgeline Quotes',
             description: 'takes a quote or estimate request in conversation and sends it',
             takes: ['quote_form'] },   // the tool name from step 1
  },
};
```

While the relay lists `quote` as available, the harness keeps the quote form tools from the model, turns a call to one into this handoff (the visitor presses **Send**), starts it for a NxisAI app link to the form, and reports a `resolved` hand-back as the form sent. Anything short of available — relay down, slow (1.5 s), no model — leaves the form exactly as it was.

**In the system prompt**, two lines — and **no form tool's name**:

```
If they ask for a quote, an estimate, or what a job would cost, call transfer_to_agent with target quote.
Only if transfer_to_agent does not offer quote, use the quote form tool instead.
```

A tool the prompt names gets called, even on a turn it was not offered. If the site routes between specialist agents (`agent.agents`), `transfer_to_agent` must be in the slice that handles quote requests.

When the agent runs as a separate service (Docker, Cloud Run, Cloudflare, Lambda), the relay can't call the agent's own availability check. Give the relay target an `availability` of its own: the agent's `/healthz` where it has one, or a check that the model key is configured.

### Step 6 — Make the sink return a reference

The agent hands back only a reference the sink returned. Have the sink answer success with one — `{ "status": "confirmed", "reference": "QR-7K2M9QXA" }`: a short prefix and eight characters from an alphabet without look-alikes (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), from a cryptographic random source. The page's form can ignore it.

If the sink can't return one, the agent still sends, and hands back "Sent to {business}. They'll follow up at {email}." with no reference. It never makes one up.

### Step 7 — Test it, then prove it live

**In process** — `references/quote-agent.test.ts` (vitest), with the project's imports and values: the harness's `HandoffController` against the relay core, the relay against the agent in-process, the model scripted, the sink watched. It checks a bad email is re-asked, a change is not a yes, a yes sends **once** with the form's exact payload, the reference is the sink's word for word, an emergency sends nothing and never reaches the model, a failed send is not retried, no model means unavailable; that `takes` hides `quote_form` and `quote_form_anywhere` while available and a call to them becomes the handoff, and that with the agent away the form is offered and runs; and that the prompt names no form tool.

**Live**, on the host's local runtime, then on production after the user sets the secrets and deploys:

| Check | Expect |
|---|---|
| `GET /api/handoff` | `quote` with `available: true`. With no model key: `available: false` |
| `POST /a2a/quote` with no or a wrong `Authorization` | 403 |
| `GET /a2a/quote/agent-card.json` | The card, pointing at this origin |
| Typed: "Can I get a quote for a new roof?" | A handoff proposal naming the agent, with **Send**. Then one question per turn, a summary, "yes", and the hand-back with the reference. The sink received one submission, identical to the form's |
| A results card's "Get a quote" (directory sites) | The same handoff, for that business — not the form |
| The NxisAI app link: `<page>?nxis_handoff=<QuoteAction @id>&nxis_report=<token>` | A new conversation proposing the handoff, not the form. Needs `on_page_agent` on: check with `nxis_mcp_settings`, and turn it on through **on-page-agent** |
| "Water is coming through my ceiling" | Hand-back with the business's phone; nothing sent |
| No model key, restart | The relay lists `quote` unavailable; the same typed request and the link open the quote form |
| The conversion | After a `resolved` hand-back, DevTools → Network: one `nxis_track_site_action` call to the site's MCP server, outcome `submitted`, carrying the link's report token when the visit came from a link. None for `unresolved` (emergency, "no", failure). A reload doesn't send it again |

**On Docker**, add these, from [hosts/docker.md](references/hosts/docker.md) "How to prove it". Before setting a key, run them with `QUOTE_TEST_MODEL=scripted` and a stub sink:

| Check | Expect |
|---|---|
| `curl http://127.0.0.1:4120/healthz` on the host | `available: true`, the model, the store. Through the public origin: 404 |
| Both card URLs through the reverse proxy | The card, pointing at `PUBLIC_ORIGIN` — not the container's address |
| A body over 64 KB with the token | 413 |
| `docker port` on the agent | `127.0.0.1` only |
| Replicas: the summary on one, "yes" on the other | Sent once |
| Replicas: the same "yes" on both at once | Sent once; the other answers "already been sent" |
| `docker compose stop redis` | `/healthz` 503 and `available: false`; the relay lists `quote` unavailable; a "yes" sends nothing. After `start`, it recovers by itself |
| `docker compose logs quote-agent` | No key, no visitor email, no token |

**On Cloud Run**, from [hosts/cloudrun.md](references/hosts/cloudrun.md) "How to prove it". First locally, against the Firestore emulator with `QUOTE_TEST_MODEL=scripted` and a stub sink: the Docker checks, two containers sharing the emulator, and the emulator stopped. Then, after the user deploys:

| Check | Expect |
|---|---|
| `GET https://<site>/a2a/quote/healthz` | `{"available":true}` only. With the relay token: the model and `"store":"firestore"` |
| `GET https://<site>/healthz` | The site's own 404 |
| The `run.app` URL, behind a load balancer | Refused: the service's ingress takes only the load balancer |
| `POST https://<site>/a2a/quote` with no token | 403 |
| A conversation from the live page | One submission, and one `quote-sent` document for the task |
| The first handoff after an idle spell | Possibly the form (a cold start); the next, the agent |
| A revision whose service account lacks Firestore access | Fails its startup probe; the previous revision keeps serving |
| Logs Explorer for the service | No key, no visitor email, no token |

**On Cloudflare**, first on `wrangler dev` (the model scripted, the sink stubbed), then on the deployed Worker:

| Check | Expect |
|---|---|
| A 70 KB `POST /a2a/quote` with the token, with and without `Content-Length` | 413 |
| The confirming "yes" sent twice at once | One submission at the sink |
| The relay drops the connection right after "yes" | The sink still gets one submission, and `GetTask` shows `COMPLETED` with the reference |
| `GET /.well-known/agent-card.json` on the site's own domain | The card, pointing at the site's origin |

**On Lambda**, first with `hosts/lambda/local-check.ts` against DynamoDB Local, then on LocalStack (`hosts/lambda.md`, "Try it on LocalStack"), then deployed:

| Check | Expect |
|---|---|
| `GET <origin>/a2a/quote/agent-card.json` | `supportedInterfaces[0].url` is the site's origin, not `*.lambda-url.*.on.aws` |
| `POST` the Function URL directly, without the token | 403 |
| After a yes, the DynamoDB table | One `sent#<task>` item, one request at the sink |
| CloudWatch Logs and the function's environment | No key material in either |

A direct handoff (not from a form call or a link) is reported only on a page with exactly one form the target takes. On a page with none — a directory's home page — a resolved quote reports nothing. That is the harness's rule, not a bug.

## Security and consent

- **The model key is server-side only.** A secret on the host, read by the endpoint. Never a public variable, never the page
- **Relay only.** The endpoint refuses any request without the relay's credential (403) and bodies over 64 KB (413). Visitors reach it only through the relay, which rate-limits them and ties each to their own task
- **Explicit confirmation, decided by rule.** The agent shows a summary written from the values — not by the model — naming the business, and sends only if the visitor's **next** message is a plain yes ("yes", "ok, send it"). "Yes, but change the email" is a change. The model never decides to send
- **One submission per task.** The task is claimed before the sink is called; a retry, a second instance or a repeated yes never sends again. A failed send is reported, not retried — the form or the phone is offered instead
- **No invented values or references.** Every value is checked server-side (required, email shape, 10–11 phone digits, choices from the options); a gap is asked for, never filled. The reference is the sink's, or none
- **Emergencies are phone calls.** A rule, before the model: hand back `unresolved` with the business's phone. No submission
- **Minimum data.** The agent sends the form's fields and nothing else; the envelope's transcript stays off (`transcript: false`). Remote replies are data to the harness, never instructions
- **LEAD_GEN, as lead-funnel-quote defines it.** One consent naming the recipient, no auto-submit, the business follows up asynchronously, nothing promised about price or timing. A handoff sends to **one** business; fan-out (up to three) is lead-funnel-quote's, not this agent's

## Best practices

- Keep `agent-core.ts` unchanged and the adapter small. Behavior lives in the core; the site lives in the adapter
- Name the agent for the business ("Ridgeline Quotes"), the same in the card, the relay label, the page label and `agentName`
- Write `facts` from the site's own data, so a new service or area reaches the agent without a code change
- Start with the emergency words the business actually gets calls about; widen them from real conversations, not guesses
- Keep the form working and tested. It is the fallback every time the agent is away
- Run the step 7 live checks in a fresh browser profile: a handoff resumes from `localStorage`, and an old session hides a new problem

## Anti-patterns

These were tried in the reference implementation, and each failed. Don't rebuild them:

- **Routing quotes with a prompt line alone.** Asked "Get a quote from McManus Electric", the model calls `quote_form_anywhere`, a tool named for exactly that
- **Hiding the form tools in the page's provider.** The prompt still named one; the model called it by name, and the harness runs a call against every tool on the page, not only those the turn offered
- **Rewriting form calls, or reading `?nxis_handoff` before the element loads, in page code.** The link's forced form call bypasses the model, and page-side workarounds dropped the report token, so conversions went unreported. `takes` does all of it in the harness
- **Naming a form tool in the prompt**, even as the fallback. Say "the quote form tool"

And:

- Letting the model decide that the visitor said yes, or write the summary the visitor confirms
- Keeping progress in memory on a host with many instances: the yes arrives where the summary isn't
- Posting to a sink URL taken from a request, the envelope or the model. It is fixed server-side
- A different payload from the form's: a sink that validates, dedupes or routes on it will treat the agent's quotes differently
- Retrying a failed send, or sending again on "did it go through?"
- A public default for the relay token. Unset, nothing may call the agent

## Worked example

**Context:** Ridgeline Roofing, one business, a Netlify site. Its home page has a quote form; the site tag registers it as `quote_form` (the QuoteAction's name is "Quote Form", `nxis:targetKind` `selfPage`). The form posts JSON to `/api/quote`, a function that saves the request to Blobs and emails the office. Harness 0.12.0; the agent-handoff relay is live with a `team` desk target.

**Step 1.** Fields: `full_name` (required), `email` (required), `phone`, `service` (Roof Replacement, Roof Repair, Gutters, Storm Damage Inspection, Other), `timeline` (Emergency — right now, This week, This month, Flexible), `project_description` (required). No hidden fields. Emergencies, the user says: water coming through the ceiling, a tree on the roof. Phone (303) 555-0142.

**Step 2.** `src/quote-form.json` from the form; the form's Astro component now renders its selects from it.

**Step 3.** `netlify/quote/agent-core.ts` copied. `netlify/quote/ridgeline-site.ts`: `providerAt` always returns Ridgeline, `match` returns `[]`; `submit` calls `saveQuoteRequest`, the function `/api/quote` already calls, and returns its reference.

**Step 4.**

> The Quote Agent sends each quote conversation — name, email, phone and the job — to Anthropic's API to decide the next question, billed to your key per turn. The request itself goes only where your quote form sends it today. OK?

They agree. `netlify/functions/a2a-quote/a2a-quote.mts` from the netlify profile; tasks, progress and the submit claim in Blobs. The profile is a draft, and the user is told so.

**Step 5.** The relay gets `quote` with `availability` on `ANTHROPIC_API_KEY`; the page gets `quote` with `takes: ['quote_form']`; the prompt gets the two lines.

**Step 6.** `saveQuoteRequest` already made a reference for the confirmation email; `/api/quote` now returns it too.

**Step 7.** The test passes. On a deploy preview: "can I get a quote for new gutters?" → **Send** → four questions → summary → "yes" → "Sent to Ridgeline Roofing. Reference RR-4KQ7M2XH. They'll follow up at pat@example.com." One request in Blobs, one email to the office, one `nxis_track_site_action`. With the key removed, the same question opens the form.

> Quote requests on your site now go to Ridgeline Quotes in conversation. It confirms every request with the visitor before sending, sends it where your form does, and hands back your reference. Without the model key, your form takes quotes as before.

## Composing with other skills

This skill composes with:

- **agent-handoff** — the relay this agent sits behind. Run it first; this skill adds one target to its adapter and does not change the relay
- **on-page-agent** — mounts the harness, and turns on `on_page_agent` so NxisAI app links carry `nxis_handoff` to this page
- **lead-funnel-quote** — the same conversion from outside the site. Its quote CTA for a `selfPage` action links to the business's page with `nxis_handoff`, and this agent takes it from there under the same `LEAD_GEN` rules
- **typed-retrieval** — the result cards whose "Get a quote" prompt and "Get a quote on their page" link both arrive here
- **action-binding** — when the sink is the user's own application: the binding, and the signing secret the agent signs with
- **agent-model-proxy** — the page's model endpoint. Separate from the Quote Agent's model call, which is server to server; the two may share a key only if the user agrees

Hand back the endpoint and card paths, the relay target, the page target and prompt lines, the sink and whether it returns a reference, where the model key lives, and the step 7 results.

This skill owns **the Quote Agent, its site adapter, the field spec, and the `takes` wiring**. It does not write the relay, change the form's sink beyond returning a reference, or choose the site's model for the on-page agent.

## Tool reference

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_get` | Read the QuoteAction by `@id`: its `name`, `nxis:input` and `nxis:targetKind` (step 1) | `id` |
| `nxis_mcp_settings` | Check `on_page_agent` before the app-link check (step 7) | `site` on the provisioning endpoint |

Everything else is files in the project and requests to the site's own endpoints.

| File | Purpose |
|---|---|
| `references/agent-core.ts` | The executor, rules, Claude adapter, Agent Card and A2A endpoint. Host- and site-neutral; copy unchanged |
| `references/example-site.ts` | A `QuoteSite` for one business or a directory, with webhook, app and `nxis_action` (draft) sinks |
| `references/quote-form.example.json` | The field spec's shape |
| `references/hosts/vite.ts`, `references/hosts/netlify.ts` | The endpoint, card and task storage per host |
| `references/hosts/docker.md` | The Docker profile: layout, the relay and reverse proxy, secrets, Redis and the claim, what happens when Redis is down, how to prove it |
| `references/hosts/docker/server.ts`, `redis-store.ts` | The container's server (`node:http`, relay-only, streaming body cap, `/healthz`), and the Redis task store, progress store and claim |
| `references/hosts/cloudrun.md` | The Cloud Run profile: request-scoped CPU, Firestore and the `create()` claim, Memorystore as the alternative, Secret Manager and the runtime service account, the front door (load balancer or Firebase Hosting), IAM and the relay token, the deploy recipe, how to prove it |
| `references/hosts/cloudrun/server.ts`, `firestore-store.ts` | The Docker server with Firestore as its store, a token-gated `/healthz` and `/a2a/quote/healthz`; the Firestore task store, progress store and claim |
| `references/hosts/cloudrun/package.json`, `.gcloudignore`, `quote-agent.tf` | The dependencies (adds `@google-cloud/firestore`), what `gcloud run deploy --source` must never upload, and the same deploy as Terraform (validated, never applied) |
| `references/hosts/cloudflare.md`, `references/hosts/cloudflare/` | Cloudflare Workers: the Worker (`worker.ts`) and its Durable Object task store, `wrangler.jsonc`, `.dev.vars.example` |
| `references/hosts/lambda.md`, `references/hosts/lambda/` | AWS Lambda: the handler (Function URL), the SAM template (DynamoDB table, least-privilege IAM), `.env.example`, a local check against DynamoDB Local, and test stubs and a driver for LocalStack |
| `references/hosts/docker/Dockerfile`, `compose.yaml`, `compose.replicas.yaml`, `.env.example`, `.dockerignore`, `package.json` | The image (`node:22-alpine`, non-root), one replica on loopback, two replicas with Redis, the variable names |
| `references/page-config.ts` | The page target with `takes`, and the prompt lines |
| `references/quote-agent.test.ts` | The in-process test |
