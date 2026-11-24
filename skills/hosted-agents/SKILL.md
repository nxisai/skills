---
name: hosted-agents
display_name: Hosted Agents
icon: puzzle-piece
source: NXISAI
description: >
  Turn on, configure, pause and check the agents NxisAI hosts on a site that is
  already on NxisAI, through the local MCP server's tools or the nxis CLI: find
  what fits in the agent catalog, give an agent the settings and connection it
  needs, resolve what holds it back, and read back whether visitors reach it.
  Works for any agent in the catalog, read at run time.
license: Apache-2.0
compatibility: >
  Any host. Needs the nxis CLI 0.2.0 or later (nxis, or npx -y
  @nxisai/cli@latest), whose local MCP server (nxis mcp serve) has the
  hosted-agent tools and their dialogs (MCP elicitation); the CLI runs every
  step without them. The site is already
  onboarded. Nothing is added to the site: its site tag loads the hosted
  agents.
metadata:
  author: nxisai
  version: 1.9
allowed_tools:
  - nxis_agents_status
  - nxis_agents_catalog
  - nxis_enable_agent
  - nxis_configure_agent
  - nxis_disable_agent
  - nxis_pause_agents
  - nxis_resume_agents
  - nxis_agents_brand
  - nxis_accept_dpa
  - nxis_list_orgs
  - nxis_use_org
  - nxis_list_sites
  - nxis_list_connections
  - nxis_create_connection
  - nxis_rotate_connection_secret
  - nxis_delete_connection
  - nxis_test_connection
  - nxis_bind_connection
  - nxis_mcp_settings
  - nxis_enable_public_mcp
  - nxis_bind_mcp_action
  - nxis_publish_entities
  - nxis_list_types
enabled: true
---

Turn on, set up, pause and check the agents NxisAI hosts for a site that is already on NxisAI: the on-page assistant, agents that answer from the site's records, agents that send requests to the business, and any agent NxisAI adds later.

Every agent is described by its entry in the agent catalog: its settings, with their limits, and what the site needs before it works. Read the entry each time and act on what it says. Do not work from a list of agents, flags or limits you remember, because a new agent needs no change to this skill and an existing one can change.

## When this skill applies

Use this skill when **all** of the following are true:

- The site is already on NxisAI: the user is signed in, the site is verified, its records are published and its site tag is live (normally by **agentic-site-onboarding**)
- The user wants a hosted agent turned on, changed, paused, resumed, turned off or checked, or wants to know which agents fit the site
- The local MCP server's tools work in this session (`nxis mcp serve`, the `nxis-onboarding` server), or you can run `nxis` in a shell (or `npx -y @nxisai/cli@latest`)

Do not use this skill for:

- First-time setup of a site. That is **agentic-site-onboarding**, whose step 12 hands off to this skill
- An agent the site hosts itself, with its own model and relay. That is **on-page-agent**, with **support-agent**, **quote-agent** or **booking-agent** behind it. A site runs its own agent or the hosted one for each job, never both
- Writing the receiver itself. Step 4 offers to build one in this project, and hands that part to **action-binding** (step 6 and its host references), then comes back here

## Before you start

**Use the local MCP server's tools when the session has them.** When the session uses the local `nxis-onboarding` server (`nxis mcp serve`, chosen in **agentic-site-onboarding** step 0), every step of this skill is a tool: `nxis_agents_status`, `nxis_agents_catalog`, `nxis_enable_agent`, `nxis_configure_agent`, `nxis_disable_agent`, `nxis_pause_agents`, `nxis_resume_agents` and `nxis_agents_brand` for the agents, `nxis_accept_dpa` for the agreement, and the connection tools (`nxis_list_connections`, `nxis_create_connection` and `nxis_rotate_connection_secret` with `write_env`, `nxis_test_connection`, `nxis_bind_connection`, `nxis_delete_connection`). Run no `nxis` command in the shell for these. Each tool returns the object its command's `--json` prints, and takes the site as `site` (an id or domain; the CLI's current site when left out) and settings **by name** in `settings` (`{"label": "Get a quote", "examples": ["…"]}`), as the catalog lists them.

**The CLI is the fallback**: for a client that cannot elicit, for the remote MCP server (which has no hosted-agent, agreement or connection tools), or by the user's preference. There, run `nxis agents …` with `--json` and settings as flags (`--label "…"`). Only the guardrails policy and stored transcripts (below) have no tool; they run in the shell, on the user's request, on every transport.

**The version.** A local server without `nxis_agents_catalog` among its tools predates them: offer `nxis update` and a reload of MCP servers (`/mcp` in Claude Code), or use the CLI. `nxis agents catalog`, and `enable`, `configure`, `disable`, `pause` and `resume` for any agent by its catalog id, come in nxis CLI 0.2.0, with the hosted-agent tools of its local server. An older CLI answers `nxis agents catalog` with `unknown_command`, and any agent other than `page` or `support` with `unknown_agent`. Say so, and offer `nxis update` (`nxis update --check` only looks). On the older CLI, `nxis agents enable page` and `nxis agents enable support --label …` still work.

**Branch on the `reason`, never on the wording of a message.** A tool failure comes back with `isError: true` and the same object the CLI prints (`ok`, `reason`, `error`, and the details). On the CLI, read the exit code first. Each call acts on the current organization and site; `--site <id|domain>` (or `site`) names another, and `nxis_use_org` (`nxis orgs use`) changes the organization. `--dry-run` shows a CLI write without sending it.

| Exit | Means | Do |
|---|---|---|
| `0` | Done | Read the result; `next` says what still holds the agent back |
| `2` | Needs the user: a choice, a connection, a setting the site lacks, an agreement, credits | Relay the message and the `reason`, follow `next` or offer the step that meets it (step 5), then make the call once more. **Never make it again unchanged before that step is done** |
| `3` | Not authorized | On the local server, the next call shows the sign-in itself. On the CLI, or after `signed_out`, `nxis login`, then the call again |
| `1` | Failed: a setting's value, an id, or the service | Report the error as given. Fix the value with the user, then make the call again |

**You make the calls; the user makes the decisions.** Never hand the user a command to run in a terminal. Each decision they own reaches them as a choice: which agent, the agreement, credits when a billed step is short, which connection, and every value visitors read. When the server's dialog asks it, that is the choice; otherwise use the harness's structured-choice affordance, or a short numbered list with the facts that matter in the message (the version and link, the price, the count), then **stop** and wait for the pick. Add **Cancel** to every choice that commits, charges or binds.

**The server asks first.** The local MCP server puts these to the user as dialogs (MCP elicitation): `nxis_enable_agent` asks which of the site's connections the agent sends through (when it needs one and none is given), then offers the data processing agreement (when the agents wait on it), then asks a yes; `nxis_accept_dpa` asks who accepts; `nxis_configure_agent` asks a yes while the agent is on (an agent that is off is changed unasked); `nxis_disable_agent`, `nxis_resume_agents` and `nxis_agents_brand` ask a yes; creating, binding, rotating or deleting a connection asks a yes. `nxis_pause_agents` never asks: it is the safe direction. When a dialog has asked and the user answered, that is their pick: act on it, and **do not ask the same question again in the conversation**, before or after the call. Say in a line what the dialog will ask, then make the call. `declined_by_user` or `cancelled_by_user` means nothing was done: do not call again unless the user asks.

**When the server can't ask.** A client that cannot elicit gets `confirmation_unavailable`, with `would_do` and the `terminal_command`. Put that decision to the user yourself as a structured choice, then on their pick run the CLI command in the shell with `--json`, and stay on the CLI for the rest of the run. `nxis … --json` in your shell never prompts either: on the CLI transport it stops with exit 2 and the options, and you put them to the user the same way.

**A refusal carries its next call.** On the local server, a refusal from the agent tools has `next`: the tool call that meets it, such as `nxis_accept_dpa`, `nxis_create_connection` with `write_env`, `nxis_bind_mcp_action` with `enabled: true`, or `nxis_enable_agent` again with `connection`. A result for an agent that is on but held back has `next` the same way. A refused enable says what it kept (`kept: ["route", "settings"]`), so the retry needs only what was missing. Follow `next` (putting any decision in it to the user, unless that tool's dialog asks it), then make the refused call once more; if it is refused again, stop and report both.

**Ask before anything visitors will see.** Turning an agent on, resuming one, or changing what it says puts that change on the live site within seconds. On the local server the dialog is that question; on the CLI, ask it yourself. Reading (`nxis_agents_status`, `nxis_agents_catalog`, `nxis_list_connections`) needs no question.

**Never turn off what you did not turn on.** Disabling or pausing an agent someone else set up is the user's call, asked as its own question.

## How the catalog describes an agent

`nxis_agents_catalog` (`nxis agents catalog --json`) lists every agent NxisAI offers, in `entries`. Each one has:

| Field | Means |
|---|---|
| `id` | What every tool takes as `agent`, and every command as `<id>` (`page`, `support`, `quote` …). Use the id the catalog gives, never one you guess |
| `name`, `job` | What people call it, and what it does for the site |
| `readiness` | `available`, `early_access` or `coming_soon` |
| `hosted` | Whether NxisAI runs it. Only a hosted agent can be turned on |
| `fit` | How well it fits this site, as a number (higher fits better); with `--by-fit` the list is ordered by it |
| `missing` | What the site lacks for it to fit better, in words |
| `added` | Whether the site has turned it on |
| `state` | For an added agent: `off`, `needs_setup`, `preview`, `paused` or `live` |
| `unmet` | The ids of the prerequisites the site has not met yet |

It filters with `job`, `industry` and `readiness` (lists), `added` (true or false), `query`, and `by_fit` (on the CLI: `--job`, `--industry`, `--readiness`, each repeated, `--added` or `--not-added`, `--query <words>`, `--by-fit`). The lists of jobs and industries come back in `jobs` and `industries`.

`nxis_agents_catalog` with `agent` (`nxis agents catalog <id> --json`) is one agent in full:

- **`flags`**: each setting, with its name (`setting`, what the tools take in `settings` and `clear`) and its CLI flag (`flag`), `type`, `required`, `max_length`, `max_items`, `item_max_length`, `min`/`max`, `allowed` values, `default` and `help`. A list setting (`repeats: true`) takes a list of text in `settings` (on the CLI, the flag once per item), and the items given replace the whole list
- **`prerequisites`**: what the site needs, each with `kind`, `label` (what people read), `met`, and when unmet a `reason` and `message`. `enforcement` says when it matters: `on_enable` refuses the agent until it is met; `on_serve` lets it turn on but keeps it from visitors (`state: needs_setup`)
- **`enable_with`** (tools): the arguments `nxis_enable_agent` needs, with its required settings as placeholders and, when it sends requests to the business, `connection`. **`enable`** is the same as a command, with its required flags and `--connection`
- **`unmet`** (tools): the ids of the prerequisites not met yet
- **`settings`** and `state`: what is set now, for an agent the site already has
- **`pausable`**: whether it has a pause of its own

`nxis_agents_status` (`nxis agents status --json`) is the site as visitors meet it: `agents`, one entry per hosted agent (`id`, `name`, `enabled`, `state`, `state_reason`, `state_message`, `settings`, `kill_switch`, `effective_kill_switch`, `site_paused`, `prerequisites`); the site-wide `kill_switch`; `live`, `waiting_on_dpa` and `go_live_blocked_by`; `verified_hosts`; `mcp_server`; `policy_version`; and `notices`.

## The pattern

### Step 1 — Read where the site stands

Confirm the organization and the site. On the local server, `nxis_list_orgs` gives the current organization (and shows the sign-in when the CLI is signed out); `nxis_use_org` picks the one the user means, and `nxis_list_sites` the site, passed as `site` from then on. On the CLI, `nxis status --json`, then `nxis sites use <id|domain>` if the site is not the one the user means. Then `nxis_agents_status` (`nxis agents status --json`).

Report what is already on, and each agent's `state` in a few words. If `live` is false, say why from `go_live_blocked_by` before anything else: an agent turned on now still won't reach visitors.

### Step 2 — Find what fits

When the user asks what is available, or names a job rather than an agent ("something that takes bookings"), call `nxis_agents_catalog` with `by_fit: true` (`nxis agents catalog --by-fit --json`), with `job` or `query` when they named one.

Put the agents to the user as numbered choices: the name, the job, the fit, the readiness, and what is missing. Say plainly which can't be turned on yet (`hosted: false`, or `coming_soon`). Do not recommend from the name alone; the fit and `missing` are the site's own evidence.

**Check the project does not already run its own agent for that job.** If it depends on `@nxisai/agent-harness`, or `nxis_mcp_settings` (`nxis mcp settings`) shows `on_page_agent` on, the site hosts its own on-page agent; a self-hosted support, quote or booking agent sits behind it. Turning on the hosted one for the same job puts two in front of visitors. Say so, and let the user choose.

### Step 3 — Read the agent's entry

`nxis_agents_catalog` with `agent` (`nxis agents catalog <id> --json`). From it, work out three things before asking the user anything:

1. **The settings to ask for.** Every required setting, and any optional one the user is likely to care about
2. **Whether it sends requests to the business:** a prerequisite of kind `connection`. Step 4 covers it
3. **What is unmet:** every prerequisite with `met: false`. Step 5 covers each

**Ask the user for every setting visitors read**: a label, a name, a description, example questions, suggestions, a message. Never invent them, and never fill one with a placeholder (including `enable_with`'s) to get past `missing_<flag>`. You may offer what the site already uses (the button text on its booking page, the name in its header) as a choice, and the user decides. Give each limit when you ask ("a label of up to 100 characters").

Leave the other settings at their defaults unless the user asks: a model, a duration, a time window. When they do, give the allowed values or the range from the entry.

### Step 4 — Give it a connection, when it sends requests to the business

An agent with a `connection` prerequisite sends what visitors ask for (a quote request, a booking) to the business's own servers, through a **connection**: a name, an https address and one signing secret, shared by every agent and action that sends there.

On the local MCP server, each step here is a tool: `nxis_list_connections`, `nxis_create_connection` with `write_env` (and `env_name` when the receiver reads another name), `nxis_test_connection`, and `nxis_rotate_connection_secret` with `write_env`. Always pass `write_env` when the receiver is in this project: without it the tool returns `signing_secret`. The server asks the user its own yes before creating. Routing the agent through the connection is `connection` on `nxis_enable_agent` (step 6), and when it is left out the server asks the user which connection in a dialog.

1. **See what exists.** `nxis_list_connections` (`nxis connections list --json`): each connection's `name`, address, `default`, and what uses it (`used_by.agents`, `used_by.action_types`). Offer the one that already receives these requests first
2. **Look for a receiver in this project.** Search the code for a handler that verifies `x-nxis-signature` or reads `NXIS_ACTION_SECRET` (an API route, a function under `netlify/functions/` or `api/`, a Worker, an Express or Fastify route). A new site usually has none
3. **Put the choice to the user** (the harness's structured choice, or a numbered list, then stop). On the local server, when the site already has connections whose receivers take these requests, you can skip this choice: test them with `nxis_test_connection`, then `nxis_enable_agent` without `connection` offers them, and "create a new one first", in its dialog (which returns `connection_required` with `next` on that pick). Otherwise, the existing connections from 1 first, then:

   > 1. **Build one in this project**: a route here that receives the requests and checks they come from NxisAI. I'll write it in your framework; you choose where the requests go (an email, a webhook, a database)
   > 2. **An existing endpoint**: an https address on your servers that already takes them
   > 3. **Cancel**

   Offer **Build** first when 2 found no receiver; when it found one, offer that receiver's address as **An existing endpoint** first. Never pick for the user
4. **Build one in this project.** Follow **action-binding** step 6 with its host reference for the project's framework ([Next.js App Router](../action-binding/references/hosts/nextjs.ts), [Netlify Functions](../action-binding/references/hosts/netlify.ts), [Vercel Functions](../action-binding/references/hosts/vercel.ts), [Cloudflare Workers](../action-binding/references/hosts/cloudflare.ts), [Express or Fastify](../action-binding/references/hosts/node.ts), sharing [`receiver.ts`](../action-binding/references/hosts/receiver.ts), [`bookings.ts`](../action-binding/references/hosts/bookings.ts) and [`submissions.ts`](../action-binding/references/hosts/submissions.ts); a static export, `output: "export"`, gets the host's function, not a route handler). Ask where submissions go, and write `deliver()` for that. For Booking, keep availability and holds on and set `calendar` from the business's hours and capacity, asking the user; [`bookings.ts`](../action-binding/references/hosts/bookings.ts) is the contract it must answer (day windows with `open`, a hold for one window, `hold_token` on the commit). Then come back here:
   - **The address.** Derive it from the site's verified host (the site `nxis_list_sites` or `nxis status --json` names) and the route the reference uses: `https://example.com/api/nxis/action`. Show it, and create the connection only on the user's yes; the address is theirs to confirm, never invented
   - **Create it with `write_env`** (`--write-env`, item 6) into the file the handler reads locally: `.env.local` for Next.js and `vercel dev`, `.env` or `.env.local` for `netlify dev`, `.dev.vars` for `wrangler dev`, `.env` for a Node server
   - **Make it reachable, then test it.** NxisAI calls the address from the internet, so it has to be deployed (a preview deploy is fine) or behind an https tunnel to a local server that serves the route: plain `next dev` doesn't serve Netlify functions, `netlify dev` does. A connection's address can't be changed in place, so a tunnel gets its own connection, deleted afterwards (`nxis_delete_connection`). Then **test it before the enable**: `nxis_test_connection` with the connection's name (`nxis connections test <name> --json`) sends it a signed check call. `verdict` is `ok`, `signature_rejected` (the handler reads another secret or verifies a parsed body), `unreachable` (it isn't deployed or the tunnel is down), `timeout` or `bad_response`, with `next`, the step that fixes it. With `ok`, read `answers_checks` too: `true` means the receiver answers availability checks, and the agents enabled on this connection afterwards start with check support on; `false` means they will send without checking first (see **action-binding**, [Turn check support on](../action-binding/SKILL.md#turn-check-support-on)). Before acting on `unreachable` or `bad_response` behind a tunnel, find where the server really runs and check the tunnel's target against it, never a dev script's default port: see **agentic-site-onboarding**, [When a tunnel or host answers with an error](../agentic-site-onboarding/SKILL.md#when-a-tunnel-or-host-answers-with-an-error). On the CLI transport, check `nxis --help` lists `connections test` first: an older CLI has no way to send a signed call, and you can't make one without the secret, which you never see. Then say so, have the user deploy (or start the tunnel), and tell them the first real request will show whether it works
   - **Then enable** (step 6). Turning the agent on before the receiver is deployed sends visitors' requests to an address that fails; say so if the user wants it on anyway
5. **An existing endpoint.** Ask for the https address that should receive the requests. Never invent the address. Then create the connection as in item 6
6. **Name it, and write the secret straight into the project's env file.** A name is 1 to 60 characters; the site's name or "Website" is usual. `make_default` (`--default`) makes it the site's default, which every action and agent without a route of its own uses. Ask before setting it. When the receiver is in this project, `nxis_create_connection` with `name`, `url` and `write_env: ".env.local"`, confirmed in its dialog; on the CLI:

   ```
   nxis connections create --name "…" --url https://… --write-env .env.local --json
   ```

   Pick the file the receiving application reads its local configuration from: `.env.local` by default, or `.env.development` where the project uses that. The variable is `NXIS_ACTION_SECRET` unless the receiver reads another name (`env_name`, `--env-name <NAME>`). Both check with git first and **refuse a file git doesn't ignore**, so the secret can't be committed by accident; if it refuses, say the file isn't ignored, and offer to add it to `.gitignore` or to use an ignored one. It creates the file if needed, replaces only that variable's line, and reports `written_to`, the variable name and `secret_preview`, never the secret. Do not print, read back or repeat it, and do not `cat` the file. Tell the user the same variable has to be set in the host's environment for production, copied from the file. The secret can never be read again; lost, it can only be replaced (`nxis_rotate_connection_secret` with `write_env`, `nxis connections rotate <name> --write-env …`), which breaks every route on that connection until the receiver has the new one
7. **Without `write_env`**, the secret comes back as `signing_secret`. An older CLI has no `--write-env`, and a flag the CLI doesn't know is ignored: on the CLI transport, check `nxis connections create --help` lists it first. Offer `nxis update`. If the user declines, or the receiver is not in this project, `create` without it returns `signing_secret` once: store it where the receiver reads its configuration (**action-binding** step 4) or give it to whoever runs the receiver, before saying anything else, and never repeat it in the conversation or a summary
8. **Route the agent through it** with `connection` on `nxis_enable_agent` (`--connection <name|id>` on `enable`, step 6). That points the agent's own route at the connection. The prerequisite is also met by the site's default connection, so on a site with one, `connection` is needed only to send this agent somewhere else

Connections need a verified site (`site_not_verified`, exit 2, otherwise). The receiver must check each request's signature; until it does, say that anyone could post to that address.

### Step 5 — Resolve what is unmet

For each unmet prerequisite, or each refusal from the enable, find its `reason` here; on the local server, its `next` names the call. **Offer the step that meets it as a choice** (with Cancel), unless that step's own dialog asks it, do that step on the user's pick, then **make the refused call once more**, changed only by what the step supplied (a `connection`, say). If it is refused again, stop and report both refusals; do not loop. When a fix changes something public or billed, it needs its own yes. When the fix is in the dashboard, send the user to the NxisAI dashboard's Agents page and say what to do there.

| Reason | Means | Resolve |
|---|---|---|
| `connection_required` | The agent sends requests and has no route to a connection. The error's `connections` lists the site's by name | Step 4: pick one with the user (or let the enable's dialog ask), build a receiver here, or use an existing endpoint, with `write_env`; then the enable again with `connection` |
| `credits_exhausted` | The organization's balance is used up | See "Credits" below, then make the call once more |
| `connection_not_found` | `connection` names none of the site's connections | `nxis_list_connections` (`nxis connections list`), and ask which one was meant |
| `connection_unusable` | The route can't be sent through (no secret, or it isn't a connection route), for `action_type` | `nxis_test_connection` shows what is wrong. Choose a working connection with `connection`. Rotate a secret only if the user asks |
| `records_missing` | The site's published records lack what the agent needs, named in `types` | `nxis_list_types` (`nxis types`) shows what is published. Unpublished drafts: `nxis_publish_entities` (`nxis publish`). Records that don't exist yet: generating them is billed, so offer **agentic-site-onboarding** step 8 (crawl, `nxis_bulk_autofill` with its scope and balance in the server's dialogs, publish), then the enable once more |
| `actions_off` | The site's actions are turned off | On a yes, `nxis_bind_mcp_action` with only `enabled: true` (`nxis actions on`); the routes are kept. A refusal there for want of a bound route (`nothing_bound` on the CLI) means bind one first (step 4, or `nxis_bind_mcp_action` with `route: "browser"`, `nxis actions bind default --self-page`) |
| `opening_hours_required` | A setting says to take times from opening hours, and the site has none | Opening hours come from the published records, or are set in the dashboard. Or, if the user prefers, choose another of the setting's `allowed` values |
| `mcp_server_not_set_up` | The agent answers from the site's MCP server, which is not set up | `nxis_mcp_settings` shows it. `nxis_enable_public_mcp` (`nxis mcp public on`) turns it on, after the user's yes (in its dialog on the local server); it makes the published records readable without a key |
| `site_not_verified` | The site is not verified | **agentic-site-onboarding** steps 5 and 6 |
| `dpa_not_accepted` | The data processing agreement for hosted agents is not accepted | "The agreement" below (`nxis_accept_dpa`), then once more |
| `dpa_not_published` | No version of the agreement is published yet, so none can be accepted | Say so; going live waits for it. Nothing to retry |
| `preview` | The site's hosted agents are in preview | The user goes live from the dashboard's Agents page |
| `agent_paused`, `site_paused` | Paused by its own kill switch, or the site's | Resume only if the user wants it (step 8) |
| `org_pinned` | The local server was started with `--org`, so it keeps acting on that organization | The user changes the server's config to act on another |
| Anything else | A reason this skill doesn't list | Relay its `message` as given. Do not guess a fix |

### Step 6 — Turn it on

**Visitors reach the other agents through the on-page assistant.** Quote, Booking, Support and the other specialists are handed off to from the on-page chat (the `page` agent): a visitor asks the assistant, and it hands off. With `page` off, the specialists are live but no visitor can reach them. So before turning one on, read `nxis_agents_status` (`nxis agents status --json`): if `page` isn't `live`, say so, and offer turning it on in the same choice ("Turn on the on-page assistant too", the recommended option; "Only this agent"; "Cancel"). On a site that hosts its own agent harness (**on-page-agent**), its own chat is the way in instead: don't enable the hosted page agent there.

**Booking: look at what the receiver's check answers.** Availability and holds come from the business's receiver, never from NxisAI. Before enabling Booking, once its connection is reachable, run a booking check: `nxis_test_connection` with `connection` and `action: "booking"` (`nxis connections test <name> --action booking --json`), and read the receiver's answer in the result as well as the `verdict`. The shape it can have is in **action-binding**, [Check answers, availability and holds](../action-binding/SKILL.md#check-answers-availability-and-holds). Then tell the user, in a line or two, what visitors get:

- **`windows`** with **`open`** counts and a **`hold`**: the full flow. Visitors see the next openings with how many are left, and a confirmed window is kept for them while they say yes
- **No `windows`**: the agent can't offer times from the receiver; visitors name a time and learn only at the end whether it is free
- **No `open`**: windows show without "N open"
- **No `hold`**: no countdown while the visitor confirms, and a commit may come back taken, with alternatives to pick from

A hold comes only with a check for one window. When the test's check names none, a missing `hold` says nothing yet: look for one in the receiver's code when it is in this project (the reference issues one), or say you couldn't tell.

**A receiver in this project, built or adopted, must answer all three.** Require `returned_windows: true`, and with holds on, the hold cases in its tests (a check for one window answers `hold`, a re-check with its `hold_token` keeps it, a commit honors it), as **agentic-site-onboarding** step 9 sets out. When one is missing, bring the receiver up to [`bookings.ts`](../action-binding/references/hosts/bookings.ts), the source of truth (with its host file), putting the change to the user first when they wrote the receiver, then test again before enabling. **A receiver run elsewhere never blocks enabling**: recommend the same section to whoever runs it, since Booking works without them. If the result carries only a verdict and no answer, read the receiver's check code in this project when it is here, or say you couldn't see what it answers. On the CLI, check `nxis connections test --help` lists `--action` first: a flag the CLI doesn't know is ignored, and the check then isn't a booking one, so say that and go on.

Say what visitors will see and where. On the local server, `nxis_enable_agent` with the user's values:

```
nxis_enable_agent { "site": "example.com", "agent": "<id>", "settings": { "<setting>": "…", "<list setting>": ["…", "…"] }, "connection": "<name>" }
```

Leave `connection` out unless the user already chose one: the server then asks which of the site's connections to use, offers the agreement when the agents wait on it, and asks the yes, each in a dialog. Don't ask those in the conversation too. On the CLI, ask the yes yourself, then run the entry's `enable` line:

```
nxis agents enable <id> --<flag> "…" [--<list-flag> "…" --<list-flag> "…"] [--connection <name|id>] --json
```

Quote every value in the shell (an accent color's `#` starts a comment otherwise). The settings are checked before anything is sent, so a bad value fails at once, and nothing changes. A tool names the setting in `field` (`settings.<name>`) and `setting`; the reason uses the flag's name either way:

| Exit 1 `reason` | Do |
|---|---|
| `missing_<flag>` | A required setting is empty. Ask the user for it |
| `<flag>_too_long`, `too_many_<setting>` | Over `limit` (with `length` or `count`). Show the user and let them shorten it; do not cut it yourself |
| `invalid_<flag>` | Breaks `rule`: out of `min`/`max`, not one of `allowed`, not an https URL, not a color, the wrong type, an empty or repeated item. Ask for a valid value |
| `unknown_setting`, `unknown_flag` | Not one of the agent's settings; `allowed` lists them. Read the entry again |
| `conflicting_settings` | The same setting given twice, or both set and cleared. Pick one |
| `model_retired` | That model is no longer offered; `allowed` lists those that are |
| `unknown_agent`, `agent_not_hosted` | No agent has that id, or NxisAI doesn't host it yet. Go back to the catalog |
| `hosted_agents_unavailable` | This NxisAI environment can't turn that agent on from here yet. The dashboard's Agents page can |
| `version_conflict` | Someone else changed the agents' settings at the same moment, after one automatic retry. Make the call again once |

In flag reasons, a flag's `-` is written `_` (`--slot-minutes`, setting `slot_minutes`, fails as `invalid_slot_minutes`).

On success, read `agent.state` and `changed`:

- `changed: false` means it was already set that way. Say "already set", not "done"
- `live`: visitors reach it now
- `needs_setup`: it is on, but `state_reason` holds it back from visitors, and `next` names the call that resolves it. Resolve it with step 5, then read back
- `preview`: on, and waiting for the site to go live (step 5, `preview` or the agreement)
- `paused`: on, and held by a kill switch

### Step 7 — Read it back

A specialist that is `live` while `page` isn't is unreachable: report it as such, never as live for visitors, and offer turning the on-page assistant on.

**Quote and Booking: check support.** Once the agent is on, test its connection again with `turn_on_checks: true` (`nxis connections test <name> --turn-on-checks --json`; add `--action booking` for Booking). Confirm `answers_checks` is `true` and `check_support_off` is empty: then Booking offers open times and holds, and Quote checks the service area, before sending. When the receiver was built here with check mode and `check_support_off` isn't empty, the flag turns it on (`check_support_turned_on`); when the user didn't ask you to set the site up, ask first. `answers_checks: false` means the receiver doesn't answer checks: say Booking takes visit requests for the business to confirm, and offer to add check mode. An enable's `check_support` (CLI) also says when the route could check and doesn't. Details and older CLIs: **action-binding**, [Turn check support on](../action-binding/SKILL.md#turn-check-support-on).

`nxis_agents_status` (`nxis agents status --json`), and find the agent in `agents`. Tell the user, in one or two lines, its state and whether visitors reach it, and anything still to do. Do not report an agent as working until its state is `live` and `live` is true for the site. Its first visitors reach it within seconds, from any page carrying the site tag, with nothing added to the site.

### Step 8 — Change it, pause it, resume it, turn it off

- **Settings:** `nxis_configure_agent` with `agent` and `settings` (`nxis agents configure <id> --<flag> "…" --json`) changes only what is given, without turning the agent on or off. `clear` (`--clear <flag>`, repeated) returns settings to their default, by name. A list setting replaces the whole list. Read the current values from `nxis_agents_catalog` with `agent` first, and ask before changing what visitors read: on the local server, the dialog asks while the agent is on
- **Where it sends:** `nxis_enable_agent` with `connection` (`nxis agents enable <id> --connection <name|id> --json`) on an agent that is already on changes its route and keeps it on
- **The kill switch:** `nxis_pause_agents` with `agent` (`nxis agents pause <id> --json`) refuses every turn of that agent; `tools: true` (`--tools`) refuses only turns that would use a tool that changes something, so answers go on; `reason` (`--reason "…"`, at most 200 characters) is what visitors are told, so ask the user for it. With no `agent` it pauses every hosted agent on the site. A pause never asks a dialog, so it takes effect at once when the user asks. `agent_not_pausable` means the agent has no pause of its own; the site-wide one still covers it
- **Resume:** `nxis_resume_agents` with `agent` (`nxis agents resume <id>`) lifts that agent's pause, and with none (`nxis agents resume`) the site-wide one, after the user's yes in a dialog on the local server. They are separate: an agent is held to the stricter of its own pause and the site's, so `nxis_agents_status` shows which is still on
- **Off:** `nxis_disable_agent` (`nxis agents disable <id>`) turns it off and keeps its settings, so enabling brings it back as it was. Only on the user's word; the server confirms it in a dialog

Pausing is the fast way to stop an agent; prefer it to disabling when the user wants it stopped for now.

## The on-page assistant's look

The chat on the site's pages (the `page` agent) is branded with `nxis_agents_brand` (`nxis agents brand`): `name` (what visitors see, at most 60 characters), `logo` and `privacy_url` (full `https://` URLs on the production host, so the logo must be deployed), and `accent` (`#rgb` or `#rrggbb`); on the CLI, `--name`, `--logo`, `--privacy-url`, `--accent`. Ask for each, offering what the project has: the site's name, a square mark in its static files, the primary color from its CSS, its privacy route. Only the parts given change; `clear` (`name`, `logo`, `accent`, `privacy_url`; `--clear name|logo|accent|privacy-url` on the CLI) resets one. The server confirms the change in a dialog. Its other settings, such as suggested questions, are in its catalog entry like any agent's.

## The agreement

Hosted agents answer visitors only once NxisAI's data processing agreement for hosted agents is accepted. Accepting binds a legal entity, so it is the user's decision alone, and you never accept it without their explicit pick.

On the local MCP server, `nxis_enable_agent` offers the agreement in its own dialog before turning an agent on, when the agents wait on it. Otherwise, or after `dpa_not_accepted`, call `nxis_accept_dpa` (with `site`) once the user wants their agents to go live. When the current version is already accepted it says so and changes nothing; otherwise it shows the user the version and its link in a dialog, and they choose who accepts: the organization, or the legal entity the site belongs to. Their answer is recorded as their acceptance. Do not put the choice below in the conversation as well; report what it returns, then make the refused call once more. On `confirmation_unavailable`, use the choice below.

On the CLI, `nxis agents dpa --json` shows the current `version`, its `url`, `accepted`, who accepted it, and `accepted_for` with `legal_entity` when the site belongs to another entity than the organization. If `accepted` is true, say so and move on. Otherwise put it to the user as a structured choice, with the version and the link in the message that asks, and ask them to read it:

1. **Accept for the organization**, for all of its sites: on this pick, `nxis agents dpa accept --yes --json`
2. **Accept for this site's legal entity**, when the site belongs to a different company: ask for the entity's exact legal name, then `nxis agents dpa accept --site <id> --entity "<name>" --yes --json`. When `legal_entity` is already set, offer only this option, with that name
3. **Cancel**: the agents stay as they are and reach no visitor until it is accepted

`--yes` records the user's own acceptance; pass it only on pick 1 or 2. Without it, `dpa accept` stops with `confirmation_required` (exit 2). `dpa_version_changed` (exit 2) means a newer version came out meanwhile: show the new one and ask again. `dpa_entity_required` means the site belongs to another entity: offer option 2. If the CLI itself already asked the user and they accepted, it reports the acceptance; do not ask again. Then run the refused command once more.

## Credits

Turning an agent on is not billed, but what clears its prerequisites can be (generating records), and a refused call can say `credits_exhausted`.

**On the local MCP server**, the billed run is `nxis_bulk_autofill` `submit` (**agentic-site-onboarding** step 8): it reads the real balance itself, and when it is short offers the credit packs in a dialog and waits for the payment, then asks its yes. Don't read the balance first, don't offer the packs in the conversation, and don't quote the plan's `credits_remaining` as the balance. On `credits_exhausted` from it (a used-up balance nobody could top up in a dialog) or `confirmation_unavailable`, use the CLI steps below.

**On the CLI**, before any billed run, and on that refusal:

1. **Read the real balance**: `nxis credits --json`, `remaining_milli` (thousandths of a credit; divide by 1,000 to show it). Do not take the balance from a plan's `credits_remaining`, which can report the allowance rather than what is left
2. **When it is short**, put a structured choice to the user: each pack from `nxis credits packs --json` with its `credits` and `price`, a smaller scope where there is one, and Cancel
3. **On a pack**, run `nxis credits buy <sku>` yourself. It opens the payment page (`--no-open` prints the link to relay) and waits until the credits land. Payment is the user's, on that page; card details never pass through you. Do not claim it went through until it exits `0` with the new `remaining_milli`. `topup_pending` (exit 2) means the payment hasn't landed: **never buy again**, which charges twice; wait for the user, then `nxis credits --json`
4. Then run the billed or refused command once more

## The policy and transcripts

These have no MCP tool, on any transport, and no setup step needs them: run them in the shell with `--json`, only when the user asks.

- **The policy.** `nxis agents policy show` prints the guardrails policy and its version; `nxis agents policy set <file.json>` replaces it whole. Change it only when the user asks. Hosted agents follow NxisAI's instructions, and a policy can't set a system prompt (`system_prompt_not_settable`)
- **Transcripts.** Visitors' conversations are stored redacted, for 30 days unless changed. `nxis agents transcripts settings` changes the retention or stores none; `list`, `show` and `export` read them. Deleting cannot be undone, and needs the user's yes

## Best practices

- On the local MCP server, use the agent tools for every step; the CLI is the fallback for a client that cannot elicit
- Read `nxis_agents_status` and the agent's catalog entry before every change, and report what was already in place
- Take ids, flags, limits and prerequisites from the catalog at run time, every time
- Put the catalog to the user as numbered choices with the fit and what is missing
- Ask for every value visitors read, with its limit, in the message that asks
- Make the calls yourself, and put each decision the user owns to them as a structured choice, unless the server's dialog asks it, then stop and wait
- Reuse a connection that already receives these requests before creating another
- Create a connection with `write_env` (`--write-env`) into the project's gitignored env file, so the secret never enters the conversation
- Test a connection with `nxis_test_connection` before turning on an agent that sends to it, and again after, with `turn_on_checks` when the receiver answers checks
- Never leave check support off on a route whose receiver answers checks: turn it on, or tell the user it is off and why
- On the CLI, read the balance from `nxis credits --json` before a billed run, and offer packs when it is short; on the local server, the submit's dialog does both
- Resolve `on_enable` prerequisites before `enable`, so the user answers one question at a time instead of meeting refusals
- After a refusal, follow its `next` (or offer the step that meets it), then retry once
- Let a prompt the CLI or the server's dialog already showed stand; don't ask it twice
- Say "already set" for `changed: false`, and "on, but not reaching visitors yet" for anything short of `live`
- Prefer a pause to turning an agent off when the user wants it stopped for now

## Anti-patterns

- Inventing a label, description, example question, pause message or connection address. An address derived from the verified host and the route you built is a suggestion until the user confirms it
- Dead-ending a site with no receiver at "give me an address": offer to build one
- Telling the user to run a command in their terminal. You run it; they choose
- Running `nxis agents` in the shell on the local MCP server, where its tools cover the step
- Asking in the conversation what the enable's dialog asks (the connection, the agreement, the yes), or asking it again after the user answered there
- Making a call again unchanged after a refusal before the step it waits on is done, or more than once after it
- Checking the balance against a plan's `credits_remaining`, buying a pack without the user's pick, or buying again after `topup_pending`
- Writing a signing secret to a file git doesn't ignore, or reading the env file back
- Hard-coding an agent's flags or limits, or assuming a new agent works like one you know
- Turning on, resuming or rewording an agent without asking, or turning off or pausing one you didn't turn on without asking
- Turning on a hosted agent for a job the site already runs a self-hosted agent for
- Pasting a signing secret into the conversation, a summary or a commit, or rotating one to recover a lost copy without the user's yes
- Making a connection the site default without asking
- Accepting the data processing agreement, or passing `--yes` to it, without the user's explicit pick of who accepts
- Generating records (billed) to clear `records_missing` without the user's consent
- Shortening a value that is too long, or replacing a refused value with one the user never saw
- Adding a script, package or key to the site for a hosted agent. The site tag brings them
- Reporting an agent as working before `status` shows it `live`
- Assuming the dev script's default port when a tunnel or connection test reports an error, or restarting a server or tunnel the user runs without asking

## Worked example

These ids and settings are this example's; read the real ones from the catalog. The session uses the local MCP server.

**User:** "Can visitors ask for a quote on my site?"

**Step 1.** `nxis_list_orgs`: signed in, the current organization is theirs. `nxis_list_sites`: `example.com`. `nxis_agents_status`: the page agent is `live`; nothing else is on; `live: true`.

**Step 2.** `nxis_agents_catalog` with `by_fit: true` lists `quote` first: job "Takes quote requests", the highest `fit` of those not added, `available`, hosted, not added, `unmet: ["connection"]`. The project has no `@nxisai/agent-harness`.

**Step 3.** `nxis_agents_catalog` with `agent: "quote"`: `label` is required (at most 100 characters), `description` and `examples` (a list, up to 10) are optional; prerequisites `records` met, `connection` unmet (`on_enable`); `enable_with` is `{"agent": "quote", "settings": {"label": "<Label>"}, "connection": "<name|id>"}`.

> The Quote agent takes quote requests on your pages and sends each one to your servers. What label should visitors see on it (up to 100 characters)? Your pages use "Request a quote".

They answer "Get a quote".

**Step 4.** `nxis_list_connections`: none. Nothing in the project checks `x-nxis-signature` or reads `NXIS_ACTION_SECRET`; it is a Vite site on Netlify, with a `netlify.toml`.

> Quote requests need somewhere on your servers to land. How do you want to do that?
>
> 1. **Build one in this project**: a Netlify function that receives each request and checks it comes from NxisAI. You choose where requests go
> 2. **An existing endpoint**: an https address that already takes them
> 3. **Cancel**

They pick 1, and want each request emailed to the inbox the site's quote form uses. **action-binding** step 6: its Netlify reference goes in as `netlify/functions/nxis-action.mts`, with `receiver.ts`, `submissions.ts` and `bookings.ts` in `netlify/lib/`, and `deliver()` sends the email through the mailer the form already uses. Its test passes. Back here: "The address will be https://example.com/api/nxis/action. Use it, named Website?" Yes. `.env` is in `.gitignore`. `nxis_create_connection` with `name: "Website"`, `url: "https://example.com/api/nxis/action"`, `write_env: ".env"`; the user confirms in its dialog, and it reports `written_to: ".env"`, the variable and a `secret_preview`; the secret itself is never shown. The user sets `NXIS_ACTION_SECRET` in Netlify's environment from the file and deploys. `nxis_test_connection` with `connection: "Website"`: `verdict: "ok"`, `answers_checks: true` (the reference answers checks), `check_support_off: []` (nothing routes to it yet).

**Step 6.**

> Turning this on puts a Get a quote option in the chat on every page. A dialog will ask you to confirm it, after showing NxisAI's data processing agreement, which your agents need before they answer visitors: please read it, then choose who accepts.

`nxis_enable_agent` with `agent: "quote"`, `settings: {"label": "Get a quote"}`, `connection: "Website"` (the one they just chose). The server shows the agreement (version 2); they accept for the organization, then confirm the enable. It returns `changed: true`, `state: "live"`. Neither question is repeated in the conversation.

**Step 7.** `nxis_test_connection` with `connection: "Website"`, `action: "quote"`, `turn_on_checks: true`: `answers_checks: true`, `check_support_off: []` (the quote route started with check support on, from the earlier test). `nxis_agents_status`: `quote` is `live`.

> Quote is live on example.com as **Get a quote**, and checks the service area with your website before it sends a request. Requests go to https://example.com/api/nxis/action, signed with the secret now in .env as NXIS_ACTION_SECRET; set the same variable in your host's environment for production. To stop it at any time, ask me to pause it.

**Later.** "Pause quotes over the holidays." `nxis_pause_agents` with `agent: "quote"`, `reason: "We're closed until January 2. Leave a message and we'll reply then."` (the wording is theirs); no dialog, and `nxis_agents_status` shows `quote` `paused`. In January: `nxis_resume_agents` with `agent: "quote"`, confirmed in its dialog, and it shows `live` again.

**On the CLI transport** the same run is `nxis agents status --json`, `nxis agents catalog --by-fit --json`, `nxis agents catalog quote --json`, `nxis connections create --name "Website" --url https://example.com/api/nxis/action --write-env .env --json`, `nxis connections test Website --json`, then, after the user's yes, `nxis agents enable quote --label "Get a quote" --connection Website --json`. That exits 2 with `dpa_not_accepted`; `nxis agents dpa --json` gives the version and link for the choice in "The agreement", and on their pick `nxis agents dpa accept --yes --json`, then the same `enable` once more, and `nxis connections test Website --action quote --turn-on-checks --json`.

## Composing with other skills

- **agentic-site-onboarding** sets the site up first, and its step 12 hands off here
- **action-binding** builds the receiver a connection sends to, from its host references (Next.js, Netlify, Vercel, Cloudflare Workers, Express, Fastify): the handler that checks each request's signature, a check without side effects and a commit once per `Idempotency-Key`. Step 4's **Build one in this project** hands off there and comes back
- **on-page-agent**, with **support-agent**, **quote-agent** and **booking-agent**, is the self-hosted alternative. A site runs its own agent or the hosted one for each job
- **mcp-discovery-publishing** re-publishes the discovery files, which link a site's hosted agents, after the first agent other than the on-page assistant is turned on
- **typed-retrieval** and the lead funnel skills are what visitors' agents use against the site's MCP server; they don't depend on the hosted agents

This skill owns **the hosted agents on a site that is already set up**: which are on, their settings, their connections, their pauses. It does not create sites, generate or publish records, write the receiver behind a connection (**action-binding** does, from step 4), or deploy.

## Tool reference

On the local MCP server (`nxis mcp serve`), every step is a tool. On the CLI transport and the remote server, use the command beside it, with `--json`.

| Tool | Command | Purpose |
|---|---|---|
| `nxis_agents_status` `{site?}` | `nxis agents status` | Every hosted agent's state, the kill switches, whether the site is live and what holds it back |
| `nxis_agents_catalog` `{site?, job?, industry?, readiness?, added?, query?, by_fit?}` | `nxis agents catalog [--by-fit] [--job …] [--industry …] [--readiness …] [--added\|--not-added] [--query …]` | The agents NxisAI offers, their fit, and what each still needs |
| `nxis_agents_catalog` `{site?, agent}` | `nxis agents catalog <id>` | One agent: its settings with limits (`flags`, by `setting`), its prerequisites with status, `unmet`, `enable_with` |
| `nxis_enable_agent` `{site?, agent, settings?, connection?}` | `nxis agents enable <id> [--<flag> …]... [--connection <name\|id>]` | Turn it on with its settings, routed through a connection when it sends requests. The server asks the connection, the agreement, then a yes |
| `nxis_configure_agent` `{site?, agent, settings?, clear?}` | `nxis agents configure <id> [--<flag> …]... [--clear <flag>]...` | Change settings without turning it on or off; a yes while it is on |
| `nxis_disable_agent` `{site?, agent}` | `nxis agents disable <id>` | Turn it off, keeping its settings; a yes |
| `nxis_pause_agents` `{site?, agent?, tools?, reason?}` | `nxis agents pause [<id>] [--tools] [--reason …]` | The kill switch, for one agent or the whole site; never asks |
| `nxis_resume_agents` `{site?, agent?}` | `nxis agents resume [<id>]` | Lift one agent's pause, or the site-wide one; a yes |
| `nxis_agents_brand` `{site?, name?, logo?, accent?, privacy_url?, clear?}` | `nxis agents brand [--name …] [--logo …] [--accent …] [--privacy-url …] [--clear …]` | The on-page chat's look; a yes |
| `nxis_accept_dpa` `{site?}` | `nxis agents dpa`, `nxis agents dpa accept --yes [--site <id> --entity …]` | The data processing agreement; the user chooses who accepts in a dialog |
| `nxis_list_orgs`, `nxis_use_org` `{org}` | `nxis status`, `nxis orgs use <id\|name>` | The current organization, and switching it |
| `nxis_list_sites` | `nxis sites list`, `nxis sites use <id\|domain>` | The site to pass as `site` |
| `nxis_list_connections` `{site?}` | `nxis connections list` | The site's connections and what uses each |
| `nxis_create_connection` `{site?, name, url, make_default?, write_env?, env_name?}` | `nxis connections create --name … --url … [--default] [--write-env <file>] [--env-name …]` | A new connection; with `write_env`, the secret goes into a gitignored env file and is never returned; a yes |
| `nxis_rotate_connection_secret` `{site?, connection, write_env?, env_name?}` | `nxis connections rotate <name\|id> [--write-env <file>]` | A new secret, the same way; only when the user asks; a yes |
| `nxis_test_connection` `{site?, connection, action?, turn_on_checks?}` | `nxis connections test <name\|id> [--action <type>] [--turn-on-checks]` | A signed check call to the receiver, its `verdict`, `answers_checks` and `check_support_off`; with the flag, check support turned on |
| `nxis_bind_connection` `{site?, action, connection}` | `nxis actions bind <action\|default> --connection <name>` | An action's or the default route through a connection; a yes |
| `nxis_delete_connection` `{site?, connection}` | `nxis connections delete <name\|id>` | Delete one nothing uses, such as a tunnel's; a yes |
| `nxis_bind_mcp_action` `{site?, enabled: true}` | `nxis actions on` | Turn the site's actions back on, keeping every route |
| `nxis_mcp_settings`, `nxis_enable_public_mcp` | `nxis mcp settings`, `nxis mcp public on` | The site's MCP server, which agents that answer from the site's records read |
| `nxis_list_types`, `nxis_publish_entities` | `nxis types`, `nxis publish` | What is published, and publishing drafts |

No tool, on any transport, and not needed for setup (run on the user's request):

| Command | Purpose |
|---|---|
| `nxis credits`, `nxis credits packs`, `nxis credits buy <sku>` | The real balance (`remaining_milli`), the packs, and buying one on the user's pick, outside a billed run (on the local server, `nxis_bulk_autofill` `submit` offers the packs itself) |
| `nxis agents policy show`, `nxis agents policy set <file>` | The guardrails policy |
| `nxis agents transcripts …` | Stored conversations and how long they are kept |
