---
name: booking-agent
display_name: Booking Agent
icon: 🗓️
source: NXISAI
description: >
  Give a site that runs @nxisai/agent-harness a conversational Booking Agent
  over A2A, and hand booking and scheduling requests to it instead of the
  page's booking form: typed requests, result-card CTAs and NxisAI app links
  alike. It asks one question a turn, offers only free slots from the site's
  own calendar in the business's time zone, validates server-side, books only
  on an explicit yes, re-checks the slot at that moment, books once, and hands
  back the site's reference. Use when a site with a booking form should take
  bookings in conversation; the form stays the fallback.
license: Apache-2.0
compatibility: >
  Needs @nxisai/agent-harness 0.12.0 or later, the agent-handoff relay, a
  host that runs server code, and an availability source the site supplies.
  Profiles: vite (draft; run in process, not on a Vite server); netlify
  (draft, not run); docker (verified locally against stubs, two replicas and
  Redis; deployment a draft); cloudrun (draft; verified locally against the
  Firestore emulator); cloudflare (draft; verified locally on wrangler dev);
  lambda (draft; verified against DynamoDB Local, not on LocalStack or AWS).
  Other hosts: asks six questions.
metadata:
  author: nxisai
  version: 1.0
  type_group: _integration
  harness_min: 0.12.0
  submit_policy: BOOKING
allowed_tools:
  - nxis_get
  - nxis_mcp_settings
enabled: true
---

Put a Booking Agent behind the site's on-page agent: an A2A agent on the site's own origin that takes a booking in conversation, offers the free times from the site's own calendar, confirms the booking with the visitor, books it exactly as the site's booking form would, and hands back the reference. The harness does the routing: the handoff target declares `takes: ['book_a_visit']`, and while the agent is available every road to the booking form leads to it instead.

The harness writes the client and the routing (`takes`). The **agent-handoff** skill writes the relay. This skill writes the agent, its adapter to the site (the calendar it reads and the sink it books into), and the page config that connects them. The harness's contract is [docs/handoff.md](https://github.com/nxisai/agent-harness/blob/main/docs/handoff.md), "Targets that take a form" and "Writing a target". The sibling for quote forms is **quote-agent**. This skill follows its shape and safety rules, and adds what a slot needs.

## When this skill applies

Use this skill when **all** of the following are true:

- The site runs `@nxisai/agent-harness` **0.12.0 or later** (normally set up in **on-page-agent**). `takes` does not exist before 0.12.0
- The site has a booking, appointment or scheduling form that the site tag registers as a tool (its JSON-LD action is a `ScheduleAction` or `ReserveAction`), and an existing place that form's bookings go (its **sink**)
- The site can answer "what's free?" from its own calendar, booking system or table, server-side (its **availability source**), or can be given an endpoint that does
- The handoff relay from **agent-handoff** is in place, or will be put in place first
- The host runs server code, and the user can deploy it and hold a model API key server-side

Do not use this skill for:

- **Booking from an outside agent** (Claude, ChatGPT through the NxisAI app) against a server-side `ReserveAction` → **lead-funnel-reservation**. Its link for a `selfPage` action opens the business's page with `nxis_handoff`, and this agent takes it from there
- **A request with no slot**, where the business calls back to arrange it → **quote-agent**, or **lead-funnel-quote**
- **Paid bookings or tickets**: price and checkout belong to Commerce Checkout, not this agent. It takes no payment, creates no account and asks for no credentials
- **A directory with a calendar per business.** This agent books one business. Run one per business, or send visitors to **lead-funnel-reservation**
- **Rescheduling or canceling an existing booking.** The agent makes new bookings only. Hand those requests back to the assistant, or to a person through **agent-handoff**
- **A site whose form should stay the only way to book** — nothing to do; the harness already fills forms

## What gets built

```
visitor ⇄ on-page agent ──handoff (takes: book_a_visit)──▶ relay ──A2A──▶ Booking Agent ──▶ the form's sink
           │  "Book a visit" text, card CTA,                (agent-      │ one model call a turn,   (webhook, app DB,
           │  ?nxis_handoff= link, a form call               handoff)     │ rules around it          or nxis_action)
           │                                                              │      │
           └─ booking away: the form, as before                           │      └──▶ the site's calendar (Availability)
                                                                          └─ hand-back: resolved + reference
```

- **The core** — `references/agent-core.ts`, copied unchanged: the executor, its rules, time in the business's zone, the injection screen, the Claude adapter, the Agent Card and the endpoint. Site-neutral
- **The site adapter** — a `BookingSite` the project writes (`references/example-site.ts` is a starting point): the business, services, locations, contact fields, rules, the availability source and the sink
- **The field spec** — one JSON file the page's form and the adapter both read, so they cannot drift (`references/booking-form.example.json`)
- **The availability source** — an `Availability` over the site's own calendar. `httpAvailability` reads an endpoint of the site's. `memoryAvailability` (with `availability.example.json`) is for trying it out and for tests, never a live site
- **The host file** — mounts the endpoint and card, and keeps tasks where the host needs them (`references/hosts/`, the same six profiles as quote-agent)
- **The page config** — the relay target `booking`, the page target with `takes`, and two prompt lines (`references/page-config.ts`)

## The host

Find the host from the project, as quote-agent does: server-side Vite plugins → vite; `netlify.toml` → netlify; a `Dockerfile` or `compose.yaml`, or a static site whose owner runs a server → docker; `wrangler.toml`/`wrangler.jsonc` → cloudflare; a SAM `template.yaml`, `serverless.yml`, CDK, or a site on CloudFront → lambda; `gcloud run deploy`, Firebase `"run"` rewrites or a Terraform `google_cloud_run_v2_service` → cloudrun. Answer these from the profile, and ask the user when there is none:

| Question | Why it matters |
|---|---|
| Where does server code live, and what does it run on locally? | Where the endpoint goes, and the origin the card points at |
| Where do tasks and progress live? | The values, the offer, the summary awaiting a yes, the attempt. Memory works on one long-lived process. With many instances, a store every request sees, or the yes lands where the summary isn't |
| Does the store have a conditional write? | The book-once guarantee: only the first claim on an attempt may book. Without one, read-then-write, and say so |
| Where do secrets live? | The model key, the relay's credential, the sink's signing secret, the calendar's bearer. Never the page, never a public variable |
| How long may one response take? | A turn is one model call plus a calendar read (a yes: a re-check plus the sink). It must fit. Where turns can be cut off, fail a task left "working" on its next read |
| Where is the calendar, and can this host reach it? | `BOOKING_AVAILABILITY_URL`: fixed server-side, reachable from the host, fast enough to read twice a turn |

Profiles, each with its status in its own file. [vite](references/hosts/vite.ts) is the quote agent's verified Vite plugin with this core, **run in process** by `hosts.test.ts` but not on a Vite server. [netlify](references/hosts/netlify.ts) is a **draft, not run**: its pieces are Copperline's booking function, verified in production, with this core in place of its executor. [docker](references/hosts/docker.md) is **verified locally against stubs**. The image ran as two replicas sharing Redis, with the real Anthropic SDK pointed at a stub Messages API and a stub site. It booked once with the summary on one replica and the yes on the other, and once with the same yes on both. It refused with Redis down and recovered by itself, and nothing personal reached the logs. Deployment is a draft. [cloudrun](references/hosts/cloudrun.md) is a **draft, verified locally**: two instances on the Firestore emulator, the same checks, and `terraform validate`. [cloudflare](references/hosts/cloudflare.md) is a **draft, verified on `wrangler dev`**, which found and fixed two Worker problems (see the profile). [lambda](references/hosts/lambda.md) is a **draft, verified against DynamoDB Local** with `local-check.ts`. Its LocalStack recipe is ported from the quote agent and not re-run. Nothing has been deployed, and no profile has made a real model call. Say which to the user.

Reach for Docker or Cloud Run for the same reasons as quote-agent: a static host, one agent for several sites, the same image locally and deployed; Cloud Run to scale to zero on Google Cloud.

## The pattern, in eight steps

### Step 1 — Find the booking form, its action, its fields and its calendar

Check `@nxisai/agent-harness` is 0.12.0 or later and the agent-handoff relay answers `GET /api/handoff`. If not, upgrade, or run **agent-handoff** first.

Then, from the project and the page:

- **The action.** In the page's JSON-LD, the `potentialAction` of `@type` `ScheduleAction` or `ReserveAction`: its `@id`, its `name`, and `nxis:targetKind`. `nxis_get` on the `@id` returns its `nxis:input` specs when they aren't inline
- **The tool name.** The action's `name`, lower-cased, spaces and dashes as `_`: "Book a Visit" → `book_a_visit`. Confirm it: ask the on-page agent to book something and read which tool its confirm card is for. A multi-step form (Copperline's `/book` → `/book/schedule` → `/book/details`) is usually one tool for its first step; `takes` that one
- **The fields.** Every input the form posts, in order: the service, the location if there is a choice, how the time is chosen (a slot id, a start and end, a date and window), and the contact fields. Ask only for what the booking needs
- **The sink.** Where the form's booking goes, what it answers on success, and **what it answers when the slot is taken**
- **The calendar.** Where free slots come from: the site's booking system, a calendar API, a table. Whether it can be read server-side, and how it identifies a slot

Ask the user for the business's **time zone** (an IANA name, `America/Chicago`), its opening hours per weekday, closed dates, the shortest notice it takes (lead time), how far ahead it books, what counts as an emergency in their trade, and the phone number for those.

### Step 2 — Write the field spec, shared with the form

One JSON file (`references/booking-form.example.json` is the shape): `posted` (the keys the form posts the service, location, slot, start, end and time zone under), then each contact field with `name`, `label`, `kind` (`text`, `email`, `phone`, `choice`, `longtext`), `required`, and optionally `pattern` and `ask` (a ZIP: `^\d{5}$`, "And the five-digit ZIP code?").

Make the form and the spec agree by construction: render the form's inputs from the spec, or add a test that compares the page's form to it. The agent posts **exactly** what the form posts — same keys, same order, same empty values. Write `bookingPayload` in the adapter to match.

### Step 3 — Supply the availability source

The core asks one thing of it:

```ts
interface Availability {
  slots(q: { service: string; location?: string; from: string; to: string; limit: number }): Promise<Slot[]>;
}
interface Slot { id: string; start: string; end: string; location?: string }   // ISO instants, with an offset or Z
```

- **Free slots only**, earliest first, starting in `[from, to)`. The `id` is the source's own: the sink is sent it back
- **The source is the truth.** The core never offers a time it didn't return, and checks each one against the site's rules too: in the business's zone, inside opening hours on its local day, not on a closed date, after the lead time, within the horizon, never past. A source that returns a slot outside the rules (a UTC hour that lands before opening once DST ends) is filtered, not offered
- **Read it server-side, at a URL fixed in configuration.** `httpAvailability` expects `GET <url>?service=&location=&from=&to=&limit=` answering `{ "slots": [...] }`; anything malformed is dropped. Write a small endpoint beside the site's booking code if there isn't one. Or implement `Availability` directly against the site's database
- **No calendar, no agent.** The hosts offer the agent as unavailable (or refuse to start) without `BOOKING_AVAILABILITY_URL`. `BOOKING_EXAMPLE_CALENDAR=true` exists for trying it out

**No holds.** The agent doesn't reserve a slot while the visitor reads the summary. At their yes it checks the slot again at the source, then books. If it is gone — taken on the site's own form, or by the sink's answer (409) — nothing is booked: the visitor sees fresh slots near the same preference, picks again, reads a new summary, and says yes again. A site whose booking system has holds can still use them inside `submit` (hold and confirm in one call); the agent's contract stays check-then-commit, as in **lead-funnel-reservation**.

### Step 4 — Write the site adapter

Copy `references/agent-core.ts` into the project unchanged, beside the host's server code. Write the `BookingSite` from `references/example-site.ts`:

| Member | What it answers |
|---|---|
| `agentName`, `role` | "Northside Booking", "books service visits for Northside Plumbing". The name matches the card and the relay label |
| `business` | `{ name, phone }`: who is booked, and the number for emergencies and failures |
| `services` | `{ id, name, description? }[]`: what can be booked, as the form posts it |
| `locations` | Branches, studios or the areas crews cover, each optionally limited to `services`. `[]` or one: never asked |
| `fields` | The contact fields, from the spec |
| `rules` | `timeZone`, `zoneName` ("Chicago time"), `leadMinutes`, `horizonDays`, `hours` per weekday (`{ mon: [['08:00','17:00']] }`), `closed` dates, `offer` (how many slots at once, default 3) |
| `locale` | How dates and times are written: `en-US` → "Tue, Nov 10, 8:00 – 10:00 AM CST" |
| `facts`, `guidance` | Two or three sentences for the model; prompt lines about this form ("offer an email once — 'no' is an answer") |
| `emergency` | `pattern` (on lower-cased text), `examples` for the model, and a safety `advice` line |
| `fallback` | Where the visitor can still book: "the booking form at /book" |
| `availability` | The source from step 3 |
| `submit(booking, key)` | Book it — once — and return `{ ok: true, reference? }`, `{ ok: false, conflict: true, alternatives? }` for a slot taken, or `{ ok: false, error }` |

**The sink** decides `submit`, as in quote-agent, plus two duties: refuse a slot that is no longer free (`conflict`), and **dedupe on the idempotency key** (`<task>.<attempt>`), answering a repeated key with the same booking:

| The form's bookings go to | `submit` |
|---|---|
| A webhook — the site's own, or the user's application via **action-binding** | `webhookSink`: POST the identical payload to a URL fixed server-side, signed (`X-Nxis-Signature: t=…,v1=<HMAC-SHA256>`), with `Idempotency-Key`. `{ status: "confirmed", reference }` is booked; `409 { status: "conflict", alternatives? }` is taken |
| A server handler that saves to the site's database | `appSink`: call the same function the handler calls (Copperline's agent calls the `/book` form's `saveSubmission`), so the office is notified the same way and the reference works at the site's lookup page |
| A server-side binding (`nxis:targetKind` `webhook` or `gateway`) | `nxisActionSink`: `nxis_action` on the Site MCP with an API key, server-side. **Draft, unverified.** A `selfPage` action cannot run this way |
| A third-party scheduler the browser posts to | The same payload, server-side, if the service accepts a server's post and has a server-side availability API. If it needs a browser token or a CAPTCHA, say so and stop |

If `references/` is not available: the core is one model decision per turn, wrapped in the rules under "Security and consent" below, plus an endpoint built on `@a2a-js/sdk` (`DefaultRequestHandler`, `JsonRpcTransportHandler`) that answers `TASK_STATE_INPUT_REQUIRED` to ask and `TASK_STATE_COMPLETED` with a `handback` part to finish. Build it to those rules, or fetch the reference from the nxisai/skills repository.

### Step 5 — Get consent, then mount the endpoint and card

Put this to the user, and **wait for an explicit yes**:

> The Booking Agent sends each booking conversation — what the visitor types, including their name, phone, address and email — to Anthropic's API to decide the next question. It runs on your API key, billed per turn. It reads free times from your calendar and books only where your booking form books today. While a conversation is open, what the visitor gave is kept in [the host's store] for [its expiry]; once it ends, only whether it booked and the reference stay. OK?

Consent to an on-page agent, or to the handoff relay, is not consent to this.

Then, from the host profile:

1. Mount `POST /a2a/booking` (the A2A endpoint, **relay only**) and `GET /a2a/booking/agent-card.json`. Serve the card at `/.well-known/agent-card.json` too only if no other agent on the site claims it
2. Keep tasks (the SDK's `TaskStore`) and progress (the core's `ProgressStore`) where the profile says, with `claim` on a conditional write
3. The model: `claudeModel(new Anthropic({ apiKey }), model)` with the key from a server-side secret and `BOOKING_MODEL` defaulting to a current Sonnet. Three tools — `ask_visitor`, `details` (every value known so far, typed from the spec, with `slot` an enum of the offered ids), `hand_back` — with `tool_choice: auto`: Claude Sonnet 5.5, Opus 5.5 and Fable 5.1 answer a forced tool choice with a 400. Without a key or a calendar, the relay must list the agent as unavailable
4. The relay's credential: a bearer token the relay sends and the endpoint checks — fresh per start in one process, a shared secret (`A2A_RELAY_TOKEN`) otherwise. No public default
5. The calendar: `BOOKING_AVAILABILITY_URL`, and `BOOKING_AVAILABILITY_TOKEN` if it wants a bearer
6. Fill in the card's words (`bookingAgentCard`): name, description, what it collects, two example requests

The profiles' `.md` files have the per-host details (Docker's reverse proxy and loopback port, Cloud Run's front door and service account, the Worker's Durable Object per task, Lambda's SSM parameters and CloudFront).

### Step 6 — Register the target, with `takes`, and the prompt lines

**In the relay** (the agent-handoff adapter):

```ts
{ name: 'booking', kind: 'agent', label: 'Northside Booking',
  description: 'an agent that books a visit in conversation from the free times on the calendar, confirms it with the visitor, and returns a booking reference',
  endpoint: '/a2a/booking', credential: () => ({ Authorization: `Bearer ${token}` }),
  transcript: false, push: false,
  availability: async () => ({ available: modelConfigured && calendarConfigured }) }
```

**On the page**, beside the site's other targets:

```ts
agent.handoff = {
  relay: '/api/handoff',
  targets: {
    booking: { kind: 'agent', label: 'Northside Booking',
               description: 'books a visit in conversation, from the free times on the calendar',
               takes: ['book_a_visit'] },   // the tool name from step 1
  },
};
```

While the relay lists `booking` as available, the harness keeps the booking form tool from the model, turns a call to it into this handoff (the visitor presses **Send**), starts it for an NxisAI app link to the form, and reports a `resolved` hand-back as the form sent. Anything short of available leaves the form exactly as it was.

**In the system prompt**, two lines — and **no form tool's name**:

```
If they want to book or schedule a visit or an appointment, or ask when someone can come, call transfer_to_agent with target booking.
Never say a time is free yourself. Only if transfer_to_agent does not offer booking, use the booking form tool instead.
```

If the site routes between specialist agents (`agent.agents`), `transfer_to_agent` must be in the booking specialist's slice.

### Step 7 — Make the sink return a reference, refuse a taken slot, and dedupe

The agent hands back only a reference the sink returned: `{ "status": "confirmed", "reference": "NB-7K2M9QXA" }` — a short prefix and eight characters without look-alikes, from a cryptographic source. With none, it still books and says "You're booked … {business} will confirm at {email}", never making one up. The sink must also answer `409` (or `conflict`) for a slot no longer free, and return the same booking for a repeated `Idempotency-Key`. The page's form can ignore all three.

### Step 8 — Test it, then prove it live

**In process** — `references/booking-agent.test.ts` (vitest, scripted models, a fixed clock, the in-memory calendar, a webhook the test plays the site's server for), with the project's imports and values: the harness's `HandoffController` against the relay core, the relay against the agent. It checks the offer comes from the calendar in the business's zone; a pick by number skips the model; a bad email, ZIP or phone, a blank, a past day, a day past the horizon, a service or slot never offered are re-asked; a model question naming a time is replaced; a change or a no isn't a yes; a yes books **once** with the form's exact payload and an idempotency key; the slot taken at the yes, or a 409 from the sink, books nothing and re-offers; two yeses at once book once and both carry the reference; a failed booking is not retried; DST in both directions; an injection in the visitor's message never reaches the model; an emergency hands back with the phone; cancel and a non-booking request hand back to the assistant; `takes` hides the form while available and gives it back when not; the prompt names no form tool. `references/hosts/hosts.test.ts` drives the vite handler over A2A.

**Live**, on the host's local runtime, then on production after the user sets the secrets and deploys. `references/hosts/lambda/localstack/stubs.mjs` (a calendar, a sink, a Messages API stub) and `drive.mjs` run the first checks against any profile without a key:

| Check | Expect |
|---|---|
| `GET /api/handoff` | `booking` with `available: true`. With no model key or no calendar: `available: false` |
| `POST /a2a/booking` with no or a wrong `Authorization` | 403 |
| `GET /a2a/booking/agent-card.json` | The card, pointing at this origin |
| Typed: "Can someone look at my water heater tomorrow?" | A handoff proposal with **Send**. Then the calendar's free times, numbered, each with the zone ("CST"), one question per turn, a summary, "yes", and the hand-back with the reference. One booking at the sink, identical to the form's |
| The same, but book the offered slot on the site's own form before saying yes | "Sorry — that time was just taken. Here's what's free now:" and nothing booked |
| A results card's "Book an appointment" / the NxisAI app link `<page>?nxis_handoff=<ScheduleAction @id>&nxis_report=<token>` | The same handoff, not the form. The link needs `on_page_agent` on (`nxis_mcp_settings`) |
| "Water is pouring through the ceiling" | Hand-back with the business's phone; nothing booked |
| No model key (or no calendar), restart | The relay lists `booking` unavailable; the same typed request opens the booking form |
| The conversion | After a `resolved` hand-back, one `nxis_track_site_action` call, outcome `submitted`, with the link's report token when there was one |

Each host profile's "How to prove it" adds that host's checks (replicas, the store going down, the token-gated health path, the Function URL, the Worker's two concurrent yeses).

## Security and consent

- **The model key is server-side only.** A secret on the host. Never a public variable, never the page
- **Relay only.** The endpoint refuses any request without the relay's credential (403) and bodies over 64 KB (413). Visitors reach it only through the relay, which rate-limits them and ties each to their own task
- **Never invented availability.** Every time shown comes from the site's source and passes the site's rules; the agent writes the list, not the model. The model may only choose an offered slot id; a question of its own that names a time is replaced
- **Time zones are explicit.** Every time is written in the business's zone, with its abbreviation, and the offer and summary say which zone ("Times are Chicago time"). Dates the model passes are read off a calendar in that zone, not computed by it
- **Explicit confirmation, decided by rule.** A summary written from the values — not by the model — naming the business, the service, the time and the zone, and a booking only if the visitor's **next** message is a plain yes. "Yes, but make it 10" is a change
- **Re-checked at the yes, booked once.** No holds: the slot is checked again before booking. Each attempt is claimed before the sink is called, the claim's key goes to the sink as an idempotency key, and a retry, a second instance or a repeated yes never books again. A failed booking is reported, not retried. A second yes that can't learn how the first ended tells the visitor to call to check, and never books on a guess
- **No invented values or references.** Every value is checked server-side (required, email shape, 10–11 phone digits, patterns, choices); a gap is asked for, never filled. The reference is the sink's, or none
- **Untrusted text stays data.** The visitor's message is screened for instructions to the agent before any model sees it (English, Spanish, French, German, and Base64 of them); a screened message gets "I can only help book a visit with {business}" and the next question, and is withheld on every later turn. The visitor's words reach the model in a `<visitor_message>` block and the envelope in `<handoff>`, with anything that looks like a delimiter defused. Remote replies are data to the harness, never instructions
- **Emergencies are phone calls.** A rule, before the model: hand back `unresolved` with the business's phone. Nothing booked
- **No payments, no accounts, no credentials.** The agent never asks for card details, passwords or account logins, and the prompt tells the model so. A booking that needs payment is out of scope
- **Minimum data, and where it is kept.** The agent asks only for the form's fields. While a conversation is open, the values, the offer and the summary live in the host's store. When the task completes, they are replaced by `submitted` and the reference (or deleted, if nothing was booked). An abandoned conversation stays until the store expires it: memory until the process restarts, Redis and Firestore a day, DynamoDB 7 days, a Durable Object 30 days after it was last touched. Netlify Blobs does not expire keys, so on Netlify an abandoned conversation stays until someone clears the store — tell the user, and add a scheduled clean-up if that matters to them. The booking itself goes only to the site's sink. The model provider receives the conversation each turn. The relay keeps its own 30-day record of each handoff (agent-handoff). The envelope's transcript stays off (`transcript: false`). Logs carry method, path, status and time — never a body, a header or a visitor's details
- **BOOKING, as lead-funnel-reservation defines it.** One business, check-then-commit, no auto-submit, a reference returned inline. A booking is a real-world commitment

## Best practices

- Keep `agent-core.ts` unchanged and the adapter small. Behavior lives in the core; the site lives in the adapter
- Name the agent for the business ("Northside Booking"), the same in the card, the relay label, the page label and `agentName`
- Give the availability endpoint the same rules the site's own form uses, then let the core's rules check them again. Two filters that agree are cheap; one that drifts books a closed day
- Keep the offer short (three) and near what the visitor asked: a pick from three is one turn
- Test across the next DST change in the business's zone, with the clock fixed
- Keep the form working and tested. It is the fallback every time the agent is away
- Run the live checks in a fresh browser profile: a handoff resumes from `localStorage`

## Anti-patterns

- **Letting the model say what's free**, or choose a time it wasn't offered. Copperline's agent let the model pick any date and window; the booking form had no calendar to check either. Fine for a request to call back, wrong for a slot
- **Booking on the model's say-so.** Copperline's agent booked the moment the model called `book_visit`, with no summary and no yes. Here the model never books; the rules do, after a yes
- **Holding a slot while the visitor thinks**, without a hold the site's system understands. An abandoned chat would block the calendar. Re-check at the yes instead
- **Times without a zone**, or in the server's zone. A visitor in another zone, or a server in UTC, turns 8:00 into 2:00
- **Arithmetic on dates by the model.** It slips on "next Thursday". Give it a calendar to read the date off, then check the date by rule
- **Retrying a booking**, or sending it again on "did it go through?"
- **A public default for the relay token**, a calendar URL taken from a request, or a sink URL taken from the model
- **Naming a form tool in the prompt**, even as the fallback. Say "the booking form tool"
- **Routing bookings with a prompt line alone**, or by hiding the form tool in page code. Use `takes`

## Worked example

**Context:** Northside Plumbing, one business on a Netlify site, `America/Chicago`. Its `/book` page has a form the site tag registers as `book_a_visit` (a `ScheduleAction` named "Book a Visit", `selfPage`). The form posts to `/api/book`, a function that saves the booking to the site's database and emails dispatch; a `/api/slots` function already feeds the form's time picker. Harness 0.12.0; the agent-handoff relay is live with a `team` desk target.

**Step 1.** Services: drain cleaning, water heater repair, boiler service. One crew, two-hour arrival windows. Fields: name, phone (required), email (optional), street, ZIP, notes. Hours Monday–Friday 8–5, Saturday 9–1; closed Thanksgiving and Christmas; two hours' notice; 30 days ahead. Emergencies: active flooding, a burst pipe, sewage backing up, a gas smell. Phone (773) 555-0142.

**Step 2.** `src/booking-form.json`; the form's component renders its inputs from it.

**Step 3.** `/api/slots` already answers `{ slots: [{ id, start, end }] }` from the database; `BOOKING_AVAILABILITY_URL` points at it.

**Step 4.** `netlify/booking/agent-core.ts` copied; `netlify/booking/northside-site.ts` from the example, with `submit` as `appSink` over the same `saveBooking` that `/api/book` calls, which now refuses a taken slot and dedupes on the key.

**Step 5.**

> The Booking Agent sends each booking conversation — name, phone, address and email — to Anthropic's API to decide the next question, billed to your key per turn. It reads free times from /api/slots and books only through the same code as /book. What the visitor gave is kept in Netlify Blobs while the conversation is open; when it ends, only the reference. Blobs don't expire, so an abandoned conversation stays until it's cleared. OK?

They agree. `netlify/functions/a2a-booking/a2a-booking.mts` from the netlify profile; the profile is a draft, and the user is told so.

**Step 6.** The relay gets `booking`; the page gets `booking` with `takes: ['book_a_visit']`; the prompt gets the two lines.

**Step 7.** `saveBooking` already made a reference for the confirmation email; `/api/book` now returns it, answers 409 for a taken slot, and keeps the key.

**Step 8.** The tests pass. On a deploy preview: "can someone clear my kitchen drain tomorrow morning?" → **Send** → "Here's what's free: 1. Tue, Nov 10, 8:00 – 10:00 AM CST, 2. … Times are Chicago time." → "2" → three questions → summary → "yes" → "You're booked: Drain cleaning, Tue, Nov 10, 10:00 AM – 12:00 PM CST (Chicago time). Your reference is NB-4KQ7M2XH." One booking, one email to dispatch, one `nxis_track_site_action`. With the key removed, the same question opens the form.

> Bookings on your site now go to Northside Booking in conversation. It offers only the times your calendar has free, in Chicago time, confirms every booking with the visitor, checks the time is still free at their yes, books it where your form does, and hands back your reference. Without the model key or the calendar, your form takes bookings as before.

## Composing with other skills

This skill composes with:

- **agent-handoff** — the relay this agent sits behind. Run it first; this skill adds one target to its adapter
- **on-page-agent** — mounts the harness, and turns on `on_page_agent` so NxisAI app links carry `nxis_handoff` to this page
- **lead-funnel-reservation** — the same conversion from outside the site, under the same `BOOKING` rules (check-then-commit, a conflict re-offers, a reference inline). Its link for a `selfPage` `ReserveAction`/`ScheduleAction` arrives here
- **quote-agent** — the sibling for requests with no slot. Both can sit behind one relay, each taking its own form
- **typed-retrieval** — the result cards whose "Book an appointment" prompt and page link both arrive here
- **action-binding** — when the sink is the user's own application: the binding, and the signing secret the agent signs with
- **agent-model-proxy** — the page's model endpoint, separate from this agent's server-to-server model call

Hand back the endpoint and card paths, the relay target, the page target and prompt lines, the availability source, the sink and whether it returns a reference, refuses a taken slot and dedupes, where the model key lives, what is kept where, and the step 8 results.

This skill owns **the Booking Agent, its site adapter, the field spec, the availability contract, and the `takes` wiring**. It does not write the relay, build the site's calendar beyond the endpoint the agent reads, change the form's sink beyond the reference, the conflict and the key, or choose the site's model for the on-page agent.

## Tool reference

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_get` | Read the ScheduleAction or ReserveAction by `@id`: its `name`, `nxis:input` and `nxis:targetKind` (step 1) | `id` |
| `nxis_mcp_settings` | Check `on_page_agent` before the app-link check (step 8) | `site` on the provisioning endpoint |

Everything else is files in the project and requests to the site's own endpoints.

| File | Purpose |
|---|---|
| `references/agent-core.ts` | The executor, rules, time in the business's zone, the injection screen, Claude adapter, Agent Card and A2A endpoint. Host- and site-neutral; copy unchanged |
| `references/example-site.ts` | A `BookingSite` for one business: rules, `memoryAvailability`, `httpAvailability`, and `memorySink`, `webhookSink`, `appSink`, `nxisActionSink` (draft) |
| `references/booking-form.example.json`, `references/availability.example.json` | The field spec's shape; the example calendar |
| `references/page-config.ts` | The page target with `takes`, and the prompt lines |
| `references/booking-agent.test.ts` | The in-process test |
| `references/hosts/vite.ts`, `netlify.ts`, `hosts.test.ts` | The endpoint, card and task storage on a Node server and on Netlify; the vite handler's test |
| `references/hosts/docker.md`, `docker/` | The container: server, Redis store and claim, Dockerfile, compose files, `.env.example` |
| `references/hosts/cloudrun.md`, `cloudrun/` | Cloud Run: the server on Firestore, the store, `package.json`, `.gcloudignore`, `booking-agent.tf` |
| `references/hosts/cloudflare.md`, `cloudflare/` | Workers: the Worker and its Durable Object per task, `wrangler.jsonc`, `.dev.vars.example` |
| `references/hosts/lambda.md`, `lambda/` | Lambda: the handler, SAM template, `.env.example`, `local-check.ts`, and `localstack/stubs.mjs` and `drive.mjs` (which also drive the other profiles) |
