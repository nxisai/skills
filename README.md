<p align="center">
  <a href="https://nxis.ai">
    <img src="https://assets.nxis.ai/nxis.svg" alt="NxisAI" width="200" />
  </a>
</p>

# NxisAI Agent Skills

Agent skills for putting a website on [NxisAI](https://nxis.ai), then using what it publishes. One set onboards a site, publishes its typed schema.org data through an MCP server, and puts an agent on its own pages. Another set queries that data and acts on it: requesting a quote, reserving a slot, filing an application.

Each skill is a folder containing a `SKILL.md`: YAML frontmatter that an agent host reads to decide when the skill applies, followed by the instructions the agent follows. They follow the [Agent Skills](https://agentskills.io) format, so they work in Claude Code and in any other host that loads `SKILL.md` skills.

## Skills

| Skill | What it does | Stage |
|---|---|---|
| [nxis-account-setup](skills/nxis-account-setup/SKILL.md) | Takes a user from no account to a working provisioning connection: sign in, name the organization, choose a plan, and install NxisAI's local MCP server, which uses the CLI's sign-in instead of a key | Set up |
| [agentic-site-onboarding](skills/agentic-site-onboarding/SKILL.md) | Signs in, picks a plan, creates and verifies a site, crawls its sitemap, generates and publishes structured data, turns on its MCP server, writes its discovery documents and the site tag, and turns on the hosted agents, through the `nxis` CLI or MCP | Set up |
| [hosted-agents](skills/hosted-agents/SKILL.md) | Turns on, configures, pauses and checks the agents NxisAI hosts on a site's pages (the page agent, Support, Quote, Booking and the rest of the catalog), with the connection each needs and the data processing agreement, and reads back whether visitors reach them | Set up |
| [mcp-discovery-publishing](skills/mcp-discovery-publishing/SKILL.md) | Publishes `ai-catalog.json` and `mcp/catalog.json` so agents can find the site's MCP server unaided, then confirms the server answers | Set up |
| [site-tag-installation](skills/site-tag-installation/SKILL.md) | Installs the NxisAI site tag so every page carries its JSON-LD and registers its actions as WebMCP tools | Set up |
| [action-binding](skills/action-binding/SKILL.md) | Routes a site's actions to a webhook in the user's own application, stores the signing secret where a redeploy finds it, and adds a handler that verifies the signature | Set up |
| [on-page-agent](skills/on-page-agent/SKILL.md) | Mounts [`@nxisai/agent-harness`](https://www.npmjs.com/package/@nxisai/agent-harness) on the site, wires it to the page's tools and the site's MCP server, and proves it works in production | Set up |
| [agent-model-proxy](skills/agent-model-proxy/SKILL.md) | Writes the server endpoint that runs the on-page agent's model, with origin, rate and size limits and a credential the browser never sees | Set up |
| [agent-handoff](skills/agent-handoff/SKILL.md) | Lets the on-page agent hand a conversation to another agent (A2A) or to a person on the team, through a relay on the site's own origin that holds the credentials and the allowlist | Set up |
| [quote-agent](skills/quote-agent/SKILL.md) | Takes quote requests in conversation instead of the page's quote form: one question a turn, sends only on the visitor's explicit yes, once, to the form's own sink, and hands back its reference | Set up |
| [support-agent](skills/support-agent/SKILL.md) | Answers how-to, product and policy questions from the site's own help content, read-only and cited by `@id`; FAQ answers are quoted exactly, and with nothing to cite it says so and offers a person. Its one write is a content gap report that carries no personal data and no question text | Set up |
| [booking-agent](skills/booking-agent/SKILL.md) | Takes booking requests in conversation instead of the page's booking form: offers only the site's free slots in its time zone, books only on the visitor's explicit yes, re-checks the slot at that moment, books once, and hands back the sink's reference | Set up |
| [agent-harness-model-bench](skills/agent-harness-model-bench/SKILL.md) | Runs the agent harness's cases in a real browser against several models at once, and scores the tool each one called, what it filled in and what the page showed, with cost and latency | Evaluate |
| [typed-retrieval](skills/typed-retrieval/SKILL.md) | Lists the schema.org types a site exposes, queries them with field filters, and fetches full records by JSON-LD `@id` | Retrieve |
| [lead-funnel-quote](skills/lead-funnel-quote/SKILL.md) | Sends a quote or contact request to up to three providers under one consent | Act |
| [lead-funnel-reservation](skills/lead-funnel-reservation/SKILL.md) | Checks and reserves a time slot, with no payment | Act |
| [lead-funnel-application](skills/lead-funnel-application/SKILL.md) | Files a job, program, rental, permit or financial-product application after the user reviews every field | Act |

## Getting started

### 1. Install the skills

Install with the open [`skills`](https://www.npmjs.com/package/skills) CLI, from the project that builds your site.

**Claude Code**: all seventeen skills, into this project:

```bash
npx -y skills add nxisai/skills --skill '*' --yes --agent claude-code
```

Add `-g` to install them for every project.

**Every agent**: every skill, into every agent the CLI detects in this project:

```bash
npx -y skills add nxisai/skills --all
```

**One skill**: swap in any skill name from the table above:

```bash
npx -y skills add nxisai/skills --skill site-tag-installation
```

Each skill is a plain `SKILL.md`, so read it before you run it.

### 2. Connect to NxisAI

The setup skills drive the `nxis` CLI, version 0.2.0 or later. Install it with the signed installer on macOS and Linux (and Windows inside WSL):

```bash
curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh
```

or run it without installing, anywhere with Node.js 20 or later, as `npx -y @nxisai/cli@latest`. The CLI signs you in through the browser and keeps its credential in the OS keychain, so there is nothing more to set up here.

`agentic-site-onboarding` asks once how your agent should reach NxisAI:

- **The local MCP server** (`nxis mcp install`), recommended when your agent can show a server's own questions (MCP elicitation; Claude Code can). The plan, credits, the agreement and every yes come to you as dialogs, and no key goes into the agent's config
- **The CLI**, `nxis … --json` in the agent's shell, when the agent can't show those dialogs or you prefer commands. The agent puts each decision to you in the conversation
- **The remote MCP server** (`nxis mcp install --remote`), only when the agent can't start a local process. It writes an MCP key into the agent's config

**If you have no account yet,** ask your agent to run `nxis-account-setup`. It signs you in, creates the organization, takes you through a plan, and installs the local MCP server. The only steps it hands back to you are signing in and paying, because those belong to a person.

**If you already have an organization id and API key,** you can add the remote server by hand instead. In Claude Code:

```bash
claude mcp add --transport http nxis-onboarding \
  https://mcp.nxis.ai/v1/organizations/<org-id>/mcp \
  --header "nxis-api-key: <api-key>"
```

Keep the API key in your agent's MCP config. Never write it into your project.

### 3. Onboard the site

Ask your agent to run `agentic-site-onboarding`. It will:

- Ask for your site's URL rather than guessing it from the repository
- Stop when verification needs a deploy. Deploy to production, because a preview won't verify
- Show you the resource count and credit balance, and wait for an explicit yes, before generating structured data
- Put the site tag on your pages and, once you say yes, turn on NxisAI's hosted agents, which the tag brings with it: no package, script or model key goes into the site

To change the hosted agents later, or pause them, run `hosted-agents`.

### 4. Host the agent yourself (optional)

To run the agent on your own pages with your own model instead of the hosted one, run `site-tag-installation`, then `on-page-agent`. If the agent's model should run on your site's server, `on-page-agent` calls `agent-model-proxy` to write the endpoint.

### 5. Send actions to your own backend (optional)

By default an action runs on the page that declares it. If a booking or quote request needs to reach your own application instead, run `action-binding`. It binds the webhook, stores the signing secret where a redeploy will still find it, and writes a handler that verifies the signature.

### 6. Confirm it answers

Once the discovery documents are deployed, run `mcp-discovery-publishing`. It checks that an agent can find the site's MCP server and that the server responds.

### Hand it to your agent

The whole setup is also written for a coding agent to follow, with no skill installed, at [nxis.ai/agent-setup.md](https://nxis.ai/agent-setup.md). Point your agent at it from the project that builds your site, and it will ask you for the rest. The skills are the longer version of those steps, with the edge cases.

## How they fit together

The skills cover a site's lifecycle in three stages, and each one hands off to the next.

![Set up: Site Onboarding runs first. Outward, MCP Discovery makes the site's MCP server findable. Onto its own pages, Site Tag then On-Page Agent, with Model Proxy when the model runs remotely. Retrieve: Typed Retrieval queries the site's MCP server and hands off an entity @id. Act: the Quote Request, Reservation and Application funnels execute it under the LEAD_GEN, BOOKING and TXN policies.](docs/skill-lifecycle.svg)

**Set up.** These skills run inside the project that builds the site. They edit files there, and stop when a step needs the user to deploy. `nxis-account-setup` comes first when there is no connection yet — every other skill assumes one exists. Then onboarding, since every remaining setup skill needs a verified site. From there the site can go in two directions:

- **Outward:** an MCP server, plus the discovery documents that point agents to it
- **Onto its own pages:** the site tag first, then an on-page agent, whose model runs either on-device or behind the proxy endpoint

`action-binding` sits across both: it decides where an action's submission lands — the page that declares it, or a webhook in the user's own application.

**Retrieve.** `typed-retrieval` works against the site's MCP server. It checks which types the site exposes, pushes the user's constraints into one filtered query, and ends at a record's `@id`. It never writes.

**Act.** The three funnel skills take a record's `@id` and run the action it advertises (its `potentialAction`) through `nxis_action`. Which funnel applies depends on what the user is committing to:

| The user wants | Action types | Skill | Policy |
|---|---|---|---|
| A quote, consultation, callback or demo; the business follows up | `QuoteAction`, `AskAction` | lead-funnel-quote | `LEAD_GEN` |
| A time slot, with no payment | `ReserveAction`, `ScheduleAction` | lead-funnel-reservation | `BOOKING` |
| To apply for a job, program, rental, permit or financial product | `ApplyAction` | lead-funnel-application | `TXN` |

Paid checkout is not part of this library.

## Consent and safety

Several of these skills spend money, change what a site serves publicly, or send someone's personal details to a business. Each one says where it asks for consent and what it does on a retry:

- **Spending credits.** Onboarding counts the resources and shows the credit balance before generating structured data. It offers to narrow the scope, and never submits a billed job twice
- **Metered endpoints.** The model proxy asks for explicit consent before writing an endpoint that bills per turn. It then proves in production that the rate limit is actually enforced
- **Secrets.** The model credential stays on the site's server, and the provisioning API key stays in the agent's MCP config. Neither is written into the project. The only token that goes into page HTML is the site tag's, which is public by design and only works on the domains it lists
- **Leads.** One consent can cover a fan-out to at most three providers, and every one of them must be named when the user agrees. A lead is never re-sent
- **Reservations.** The skill checks opening hours, and availability where the business supports it, then confirms the exact slot before committing
- **Applications.** The user reviews every field before submission, and only values they provided or approved are sent. Documents go by reference, not as raw content. Nothing is submitted automatically, and a failed or timed-out filing is never retried without the user
- **Honest results.** No skill invents a confirmation, reference number or response time. Each reports only what the server returned

## Requirements

- **A NxisAI account, for the setup skills.** They reach NxisAI through the `nxis` CLI or an MCP server, as in [step 2](#2-connect-to-nxisai). Generating structured data spends credits on your NxisAI plan, and onboarding shows you the count before it asks. The skills themselves are free
- **A site's MCP server, for retrieval and the funnels.** `typed-retrieval` works against any public NxisAI MCP server: its read tools (`nxis_list_types`, `nxis_query`, `nxis_get`) need no key. The funnels need a signed-in caller, because `nxis_action` never writes anonymously
- **For the setup skills:** the site's source project, and the ability to deploy it. Verification needs a tag live on the production site, which the user deploys
- **For `on-page-agent`:** `@nxisai/agent-harness` 0.2.4 or later. A remote model also needs a host that runs server code

## Hosting

No setup skill hard-codes a host in its steps. Anything that depends on the host is answered from the project's own configuration or from a host profile. For a host with no profile, the skill asks the user.

| Host | Status |
|---|---|
| Netlify | Verified end to end |
| Vercel | Draft profile |
| Cloudflare | Draft profile; quote-agent, booking-agent and support-agent also verified locally under `wrangler dev` |
| Docker | Verified locally; deployment is a draft (agent-model-proxy, quote-agent, booking-agent, support-agent) |
| Node (Express, a Vite dev server) | Draft profile for agent-handoff; quote-agent verified on a Vite dev server; booking-agent and support-agent draft, run in process |
| AWS Lambda | Draft profile: quote-agent verified on LocalStack, booking-agent against DynamoDB Local |
| Google Cloud Run | Draft profile, verified against the Firestore emulator (quote-agent, booking-agent, support-agent) |
| Other | The skill asks the user a few questions about the host |

The host profiles are in [skills/agent-model-proxy/references/hosts/](skills/agent-model-proxy/references/hosts/), [skills/agent-handoff/references/hosts/](skills/agent-handoff/references/hosts/), [skills/quote-agent/references/hosts/](skills/quote-agent/references/hosts/), [skills/booking-agent/references/hosts/](skills/booking-agent/references/hosts/) and [skills/support-agent/references/hosts/](skills/support-agent/references/hosts/). When a skill uses a draft profile, it tells the user and checks the unconfirmed answers against the host's own documentation.

## Writing a skill

A skill is a folder whose name matches the `name` in its frontmatter:

```
skills/
  your-skill-name/
    SKILL.md
    references/     # optional
```

Every `SKILL.md` has:

1. **Frontmatter**: `name`, `display_name`, `icon` (a [Heroicons](https://heroicons.com/) v2 outline name in kebab case, such as `rocket-launch`, never an emoji), `source`, `description`, `license`, `metadata`, `allowed_tools` and `enabled`, plus `compatibility` when the skill depends on where the site is hosted
2. A one-line summary
3. **When this skill applies**: the conditions that must all hold, and the exclusions, each naming the skill to use instead
4. The pattern, as numbered steps
5. Best practices
6. Anti-patterns
7. A worked example
8. **Composing with other skills**: the handoffs, and a statement of what the skill does not own
9. A tool reference table

Start from the closest existing skill: [typed-retrieval](skills/typed-retrieval/SKILL.md) for a read-only skill, [agentic-site-onboarding](skills/agentic-site-onboarding/SKILL.md) for a provisioning workflow, or one of the lead funnels for anything that calls `nxis_action`.

A few rules hold across the library:

- **List only the tools the skill calls** in `allowed_tools`. Use an empty list for a skill that calls none
- **Any skill that writes must say where it asks for consent** and what happens on a retry
- **`SKILL.md` must stand on its own.** Some hosts import only that file, so everything the skill needs to run belongs in it, including how to ask for anything a reference file would have answered
- **Keep host names out of the steps.** Where a step depends on the host, say what has to be true and put each host's answer in a profile. Mark a profile verified only once the skill has run against that host end to end

## License

[Apache License 2.0](LICENSE). The NxisAI name and logo are not covered by it; see [TRADEMARK.md](TRADEMARK.md) and [NOTICE](NOTICE).
