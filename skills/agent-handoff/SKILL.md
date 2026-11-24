---
name: agent-handoff
display_name: Agent Handoff
icon: arrow-uturn-right
source: NXISAI
description: >
  Let a site's on-page agent hand a conversation to another agent (A2A 1.0)
  or to a person on the team, through a relay on the site's own origin that
  holds the credentials, the target allowlist and the record of what was
  shared. Use when a site running @nxisai/agent-harness should pass visitors
  to a booking agent, a partner's agent, a help desk or a Discord channel.
license: Apache-2.0
compatibility: >
  Any host that runs server code and has somewhere to keep a small record.
  Profiles: netlify (verified); node (draft — Express, a Vite dev server, any
  Node server). Other hosts: asks five questions.
metadata:
  author: nxisai
  version: 1.1
  type_group: _integration
allowed_tools: []
enabled: true
---

Write the server half of the harness's handoff: one relay on the site's own origin that the on-page agent hands conversations through, to agents over A2A and to people behind a desk — and the page config that names who they can go to.

The harness writes the client: the `transfer_to_agent` and `talk_to_a_person` tools, the confirmation the visitor presses Send on, the conversation with the target, the way back. This skill writes the relay and chooses the targets. The contract between them is the harness's [docs/handoff.md](https://github.com/nxisai/agent-harness/blob/main/docs/handoff.md); every rule in it is silent when broken.

## When this skill applies

Use this skill when **all** of the following are true:

- The site runs `@nxisai/agent-harness` 0.6 or later — normally set up in **on-page-agent**
- Visitors should be able to reach someone the on-page agent can't stand in for: an agent that finishes a job (a booking, a claim), or a person
- The site's host can run server code, and you are in the project that builds the site, with a user who can deploy it

Do not use this skill for:

- Letting *other* agents reach this site. That is the site's MCP server (**mcp-discovery-publishing**), or an inbound A2A agent — a separate design
- Running a form's action server-side. That is `nxis_action` and **action-binding**
- A site whose host serves static files only. There is nowhere for the relay's credential or records to live

## What gets built

```
visitor ⇄ on-page agent ──same origin──▶ relay ──A2A 1.0──▶ agent target
                                           │  └──A2A 1.0──▶ desk (people)
                                           └─ records: who, what was shared, how to reach them
```

- **The relay** — `references/handoff-core.ts`, copied into the project unchanged, plus a thin adapter for the host. Origin and size checks, the target allowlist, a key per handoff so one visitor can't read another's, records kept 30 days (with the visitor's email address, and for a person target their phone and name: never their address), and follow-up by email for a person's reply that arrives after the visitor left
- **The targets** — an allowlist in the adapter. Each is an A2A endpoint the relay reaches with a credential only the server holds
- **The page config** — `agent.handoff = { relay, targets }`, naming the same targets with the labels a visitor reads

## The host

Five things differ between hosts. Answer them from `references/hosts/<host>.md` when one exists, and ask the user when none does:

| Question | Why it matters |
|---|---|
| Where does server code live, and what does it run on locally? | Where the adapter goes, and the local origins the allowlist must include |
| Where do records live? | A key-value store the relay's requests all see. Not process memory on a host that runs many instances |
| Where do secrets live? | Target credentials. Never a public environment variable, never the page |
| What is the rate-limit primitive, and how is it proved? | The one defense that has to be the host's own |
| How long may one response stream? | A person takes minutes to answer. Streams will be cut; the harness resumes them, but the target must not be one that only answers inside one long response |

Profiles: [netlify](references/hosts/netlify.md) is verified in production (Copperline). [node](references/hosts/node.md) is a draft; it says which answers are unconfirmed.

## The pattern, in seven steps

### Step 1 — Find the host and the harness version

Find the host from the project (`netlify.toml`, `vercel.json`, `wrangler.toml`, a Node server) and load its profile. Check `@nxisai/agent-harness` is 0.6 or later; upgrade it first if not — `agent.handoff` does not exist before 0.6.

### Step 2 — Choose the targets, with the user

Ask who conversations should be able to go to. For each, record a **name** (lower case, the relay's and the page's key), a **label** (what a visitor reads), a **kind**, and a one-line **description** the model uses to pick between them.

**An agent** — the user gives its Agent Card URL, or its A2A endpoint. Read the card and check, before writing anything:

- `supportedInterfaces` lists `"protocolBinding": "JSONRPC"` with `"protocolVersion": "1.0"`. Anything else is a different protocol version the harness does not speak
- `capabilities.streaming` is `true`, or the conversation will only move when the visitor writes
- What credential the agent expects (`securitySchemes`), and where the user will put it — a secret on the host, from step 4

**A person** — ask where the team already works:

| Where | Target |
|---|---|
| Discord | NxisAI's Discord adapter: each handoff becomes a thread in a support channel. Endpoint and relay token from the adapter's operator |
| Zendesk, Intercom, another desk | An adapter that puts an A2A face on it — the contract is in docs/handoff.md, "A desk for people". Build or buy it before this skill finishes; the relay can't target a desk directly |
| Nowhere yet, on Netlify | Copperline's reference desk: `netlify/functions/a2a-desk.mts`, `desk-api.mts`, `netlify/lib/desk.ts` and `src/app/desk/`. Copy it, with the user's agreement that it's a starting point, not a product |

For a person, ask their **hours**, and whether an after-hours visitor may leave an email for a reply. The relay's `availability` answers from them.

For each target, ask whether the **transcript** — the visitor's last turns — may be shared. Default **no**: the summary the visitor sees is what goes.

### Step 3 — Get consent to what leaves the site

A handoff sends what a visitor said to someone else. Put it to the user, and **wait for an explicit yes:**

- Each handoff carries a summary the visitor sees and confirms, the page they were on, and — only if they give it — an email for a reply. With transcript sharing on for a target, their last turns go too
- The relay keeps a record of each handoff for 30 days: who it went to, the reason and the page, and how to reach the visitor. Of the details they left, it keeps the email address for every target (so a request from them can find their records) and, for a person target, the phone and name too. An agent target may be sent more for its conversation with them, a street address for a visit among it; the relay keeps none of that (`keptRecord`)
- A partner's agent receives that data under the partner's terms. The site's privacy notice should say so

Consent to an on-page agent is not consent to this.

### Step 4 — Write the relay

1. Copy `references/handoff-core.ts` into the project unchanged, beside the host's server code
2. Write the adapter from the host profile. It supplies:
   - `allowedOrigins` — full origins, scheme and port included, exactly as a browser sends them: production, and each local origin. Every one must be on a host the site tag's token allows, or one half of the agent will work where the other doesn't
   - `store` — the host's key-value store, from the profile
   - `targets` — the allowlist from step 2. `endpoint` is the target's A2A URL; `credential` reads a secret: `() => ({ Authorization: \`Bearer ${process.env.BOOKING_AGENT_TOKEN}\` })`
   - `pushUrl` and `notify` — for a person target that pushes, so a reply reaches a visitor who left: the push path on this site, and an email sender (Resend, or whatever the site already sends mail with). Without `notify` replies to absent visitors are only logged
   - the host's rate limit — 60 requests a minute per visitor: a conversation is a few requests a minute, plus reconnects while a person types
3. Serve it at `/api/handoff` and `/api/handoff/*`, and the push handler at a path **outside** the rate limit (`/api/handoff-push`): pushes come from the targets' servers, not from visitors
4. Put each credential in the host's secret store. Never in the page, never in a public variable

### Step 5 — Name the targets on the page

Where the site mounts the agent:

```ts
agent.handoff = {
  relay: "/api/handoff",
  targets: {
    booking: { kind: "agent", label: "Booking", description: "books a service visit in conversation" },
    team: { kind: "person", label: "Our team", description: "a person at the office" },
  },
};
```

The names match the relay's. A target must be in both to be offered: the page names it for the visitor, the relay decides what is reachable. A target that should stand in for one of the page's forms also declares `takes` with the form's tool name: `quote` takes the quote form (**quote-agent**), `booking` the booking form (**booking-agent**).

If the site routes between specialist agents (`agent.agents`), `talk_to_a_person` must be in **every** specialist's tool slice, and `transfer_to_agent` in the ones whose work a target finishes. A tool no slice holds is never offered. Add a route rule for asking for a person — "talk to a person", "a human", "a representative" — to an agent that holds it.

Tell the prompts when to use them, in a sentence each: `talk_to_a_person` when the visitor asks for a person or the agent can't help; `transfer_to_agent` with the target's name when that target finishes the job.

### Step 6 — Test it on the host's local runtime

First, `references/handoff-core.test.ts` (vitest), copied beside the core: an agent target's record keeps only the visitor's email address, a person target's the email, phone and name, and neither keeps their street, city or ZIP code.

Then run the site on the host's local runtime from the profile, and:

| Check | Expect |
|---|---|
| `GET /api/handoff` | Each target, with `available` |
| `POST /api/handoff/<name>` with a foreign `Origin` | 403 |
| `POST /api/handoff/nobody` | 404 |
| `POST /api/handoff/<name>` with a `GetTask` for a task id and no `Nxis-Handoff-Key` | 403 |
| In the page: "I'd like to talk to a person" | A proposal naming the team, with the summary, and **Send** |
| Send, then answer from the desk (or the Discord thread) | The reply appears under the operator's name; the bar says who is listening |
| Close it with a reference from the desk | The reference in the thread, and "Back with the assistant" |
| Ask the agent target to do its job | Its questions, then its hand-back |

A proposal that never appears means the tools aren't in the turn's slice (step 5), or the relay's `GET` failed — the harness offers no targets it can't list.

### Step 7 — Deploy, then prove it

Tell the user to set the secrets from step 4 on the host, and deploy. Then, against production:

- The step 6 checks, from the production origin
- **The rate limit is enforced, not configured:** 61 POSTs to `/api/handoff/nobody` inside a minute. Sixty 404s, then a 429. None reach a target, so it costs nothing
- One real handoff to each target, ended with **Back to the assistant**, so nothing is left open at the target
- For a person target with email: hand off, close the tab, reply from the desk, and check the email arrives

## Best practices

- Keep `handoff-core.ts` unchanged and the adapter thin. The next harness version's relay contract lands as a new core
- Start with the transcript off for every target. Turn it on for one when its operator asks, and say so in the privacy notice
- Give each target a label a visitor recognizes — the business's name for the desk, the product's name for the agent
- For a person target, set honest hours. An after-hours visitor who leaves an email and hears back tomorrow is well served; one left in a queue nobody watches is not

## Anti-patterns

- Putting a target's URL or credential in the page. The browser knows names and labels, nothing more
- Letting the page, the model or a remote reply add a target. The relay's list is the list
- Forwarding `ListTasks`, or any method but the five. Tasks belong to visitors, one each
- Keeping records in process memory on a host with many instances. The key check then fails at random
- Serving push notifications behind the visitor rate limit. A busy desk trips it, and follow-up emails stop
- A person target that can only answer inside the request the visitor is streaming on. Nobody types that fast; the desk must keep the task in storage

## Worked example

**Context:** the listings demo, a Vite site served through a tunnel, runs the harness. Its businesses take bookings through Copperline's booking agent, and there is no desk yet.

**Step 1.** No host config: a Vite dev server with plugins. The node profile, draft. Harness 0.6.

**Step 2.** One target: `booking`, an agent, label "Copperline Booking". Its card lists JSONRPC 1.0, streaming. It expects `Authorization: Bearer <token>`; the user puts the token in `.env` as `COPPERLINE_A2A_TOKEN`. No person target for now. Transcript: no.

**Step 3.**

> A handoff sends Copperline's booking agent the summary your visitor confirms and the page they were on, and keeps a record of it for 30 days. Nothing else goes unless they type it to the agent. OK?

They agree.

**Step 4.** `plugins/handoff-core.ts` copied; `plugins/handoff.ts` is a Vite plugin mounting it at `/api/handoff`, with a file-backed store under `.data/handoff/` and the token from `.env`.

**Step 5.** `agent.handoff = { relay: "/api/handoff", targets: { booking: { kind: "agent", label: "Copperline Booking", description: "books a visit in conversation" } } }`.

**Step 6.** `GET /api/handoff` lists `booking`. A foreign origin is 403, a key-less `GetTask` 403. In the page, "can your booking agent book me a visit?" proposes the handoff; the agent asks for a day, books it, and hands back a reference.

> Visitors can now hand a booking to Copperline's agent from any listing. Each handoff sends only the summary they confirm and the page they're on; the relay keeps a 30-day record of it, and each visitor's conversation is locked to their own browser.

## Composing with other skills

This skill composes with:

- **on-page-agent** — mounts the agent this skill configures; run it first
- **agent-model-proxy** — the model's endpoint. The relay sits beside it with the same origin list
- **quote-agent** — an agent target for quote requests that takes the page's quote form's place (`takes`). Run it after this skill; it adds one target to the relay
- **booking-agent** — the same for bookings: an agent target `booking` that takes the booking form's place, offering only the free slots from the site's own calendar. Run it after this skill; it adds one target to the relay
- **support-agent** — an agent target that answers support questions from the site's help content, with cited cards, and hands back to a person target here when the visitor wants one. Run it after this skill; it adds one target to the relay
- **The host's own skills**, when the project has them — for functions, key-value stores, secrets and deploys

Hand back the relay path, the target list (name, kind, label, endpoint, transcript), where each credential lives, and the step 7 results.

This skill owns **the relay, its defenses, and the target list**. It does not build an A2A agent or a help desk — it connects to them — and it does not decide what the on-page agent says.

## Tool reference

This skill calls no NxisAI tools. Its work is files in the project and requests to the site's own relay.

| File | Purpose |
|---|---|
| `references/handoff-core.ts` | The relay: the contract and its defenses. Host-neutral; copy it unchanged |
| `references/handoff-core.test.ts` | What a record keeps of the visitor's details, for each kind of target (vitest). Copy it beside the core |
| The host adapter | Storage, secrets, origins, the rate limit and the push path — from `references/hosts/<host>.md` |
