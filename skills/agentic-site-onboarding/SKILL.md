---
name: agentic-site-onboarding
display_name: Site Onboarding
icon: rocket-launch
source: NXISAI
description: >
  Onboard a site onto NxisAI from its own project, through the nxis CLI or MCP:
  sign in, pick a plan, verify the site, crawl it, publish structured data, turn
  on its MCP server, write discovery files and the site tag, and turn on the
  hosted agents.
license: Apache-2.0
compatibility: >
  Any host. Runs inside the project that builds the site; the user deploys.
  Needs the nxis CLI 0.2.0 or later (nxis, or npx -y @nxisai/cli@latest),
  whose local MCP server (nxis mcp serve) has a tool and a dialog (MCP
  elicitation) for every step. The CLI transport runs every step without
  elicitation. The remote MCP server has the site tools only.
metadata:
  author: nxisai
  version: 3.3
allowed_tools:
  - nxis_list_orgs
  - nxis_use_org
  - nxis_create_org
  - nxis_choose_plan
  - nxis_accept_dpa
  - nxis_list_sites
  - nxis_create_site
  - nxis_verify_site
  - nxis_crawl_sitemap
  - nxis_bulk_autofill
  - nxis_publish_entities
  - nxis_list_types
  - nxis_query
  - nxis_mcp_settings
  - nxis_enable_public_mcp
  - nxis_bind_mcp_action
  - nxis_list_connections
  - nxis_create_connection
  - nxis_rotate_connection_secret
  - nxis_delete_connection
  - nxis_test_connection
  - nxis_bind_connection
  - nxis_aio_files
  - nxis_site_tag
  - nxis_set_site_name
  - nxis_list_in_app
  - nxis_agents_status
  - nxis_agents_catalog
  - nxis_enable_agent
  - nxis_configure_agent
  - nxis_disable_agent
  - nxis_pause_agents
  - nxis_resume_agents
  - nxis_agents_brand
enabled: true
---

Onboard a site onto NxisAI from inside the developer's own project: sign in, choose a plan, create and verify the site, ingest its pages, generate structured data, expose it as an MCP server, put the site tag on its pages, and turn on the hosted agents that the tag brings with it.

You are running where the site's source lives. That is the reason this can be done at all: verification and the site tag are file changes and a deploy, not something a browser wizard can do for someone.

**You drive the setup; the user decides.** Run every command yourself. Never hand the user a command to run in a terminal, and never end a step with "run `nxis …` when you're ready". What the user owns is a set of decisions, and each one is put to them as a choice inside this conversation:

| Decision | Step | The choice |
|---|---|---|
| The organization | 2 | One of theirs, or a new one with the name they give |
| The plan | 3 | Each plan with its price, interval and credit grant, and Cancel |
| Credits, when the balance is short | 8, and any billed run | Each credit pack with its credits and price, a narrower scope, and Cancel |
| The structured data and its scope | 8 | The mode, all pages or a path cluster with its count, and Cancel |
| The data processing agreement | 12 | Accept for the organization, accept for this site's legal entity, or Cancel |
| Where submissions land | 9, 12 | Build a receiver in this project, an existing endpoint, or Cancel |
| Which connection a hosted agent sends through | 12 | Each of the site's connections, or a new one first |
| A connection's address and name, a label visitors read | 9, 12 | What the user gives or confirms; never a value you made up |
| Changing a committed file for a test host | 4, 5, 10, 11 | Change it, keep the change out of the shared files, or Cancel (see "A host that isn't production") |

Use the harness's structured-choice affordance when it has one (a question with options, a picker). Otherwise write a short numbered list, with the numbers that matter in the message that asks, and **stop**: end the turn and wait for the pick. Never read silence, "go ahead" or "set me up" as a pick of a paid or binding option. Payment and sign-in stay on their own pages; you send the user there and wait, and card details, passwords and signing secrets never pass through you.

**The server may ask first.** On the local MCP server (step 0), these decisions reach the user as dialogs from the server itself (MCP elicitation): the sign-in, the plans, the credit packs, the autofill scope, the agreement, the connection a hosted agent sends through, and a yes before anything billed, public or seen by visitors. When a dialog has asked and the user answered, that answer is their pick: act on it, and **do not ask the same question again in the conversation**, before or after the call. The CLI does the same in a terminal, but `nxis … --json` in your shell never prompts: on the CLI transport, and whenever the server could not ask (`confirmation_unavailable`), it stops with exit 2 and the options, and you put them to the user as above.

## When this skill applies

Use this skill when **all** of the following are true:

- The user wants a site set up on NxisAI, and can sign in with Google in a browser
- You are running in the project that builds the site, and can run `nxis` in a shell (or `npx -y @nxisai/cli@latest`, which runs the same commands)
- The site is one the user can deploy

Do not use this skill for:

- A site already onboarded, or changing an existing site's settings. This is first-time setup. Turning on, changing or pausing a hosted agent later is **hosted-agents**
- Sites you cannot deploy. Verification will never pass, and every step after it does nothing
- A site that renders on a server and wants its JSON-LD in the HTML response (`NxisClient`) instead of the CDN tag. That path is **site-tag-installation**
- Hosting the agent harness on the site yourself, with your own model and relay. That is **on-page-agent**, and it replaces the hosted page agent in step 12 rather than adding to it

## Step 0 — Choose the transport, once

**First, the CLI.** Every transport needs it. Check with `nxis --help`. If it is missing, install it: `curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh` on macOS and Linux (and Windows inside WSL), which checks the release's signature and checksum and puts `nxis` in `~/.local/bin`; or, anywhere with Node.js 20 or later, write `npx -y @nxisai/cli@latest` wherever this skill says `nxis`. If `nxis --help` has no "Hosted agents" section, the CLI is older than 0.2.0: run `nxis update`, or install again. Never pin a version from memory; use the installer or the `latest` tag.

Every step below can run through one of three transports. They reach the same NxisAI services and the same site, so a run can switch between them, but ask once, early, and stay with the answer.

| Transport | Set up with | Credential | Pick it when |
|---|---|---|---|
| **MCP, local** (stdio; recommended when the agent supports MCP elicitation) | `nxis mcp install`, then reload MCP servers (`/mcp` in Claude Code) | None in the agent's config: it runs `nxis mcp serve`, which uses the CLI's sign-in | The agent's client can show the server's questions (Claude Code can) |
| **CLI** (the fallback) | Nothing more: `nxis … --json` in the shell | The CLI's own sign-in, in the OS keychain | The client cannot elicit, or the user prefers commands. Every step has one |
| **MCP, remote** | `nxis mcp install --remote`, then reload | An MCP key, written into the agent's config | The agent cannot start a local process |

**Why local MCP first.** It has a tool for every step, and its server puts each decision (the sign-in link and code, a new organization, the plan, credit packs, the autofill scope, the agreement, the connection a hosted agent sends through, a yes before anything billed, public or seen by visitors) to the user as a dialog in their client, which they answer and the model cannot answer for them. And no key sits in the agent's config. On the **CLI** transport you run `nxis … --json`, which never prompts, so you put each of those decisions to the user yourself as a structured choice, as above.

**Telling whether the client can elicit.** Claude Code can. For another client, say what you know; if you can't tell, offer local MCP anyway: a client that cannot elicit answers the first call that needs a decision with `confirmation_unavailable`, and nothing is done. Then switch to the CLI for the rest of the run, putting that decision to the user yourself.

Put it to the user as a numbered choice: **local MCP first, marked recommended**, when the client supports elicitation; otherwise **CLI first, marked recommended**. Remote MCP is last either way. If `nxis-onboarding` tools already work in this session, offer to keep using that connection as a fourth option, and do not reinstall it: `nxis mcp install` stops with `server_exists`, and `--force` would replace a server that may point at another organization.

Whatever the transport:

- **The local MCP server covers every step.** Sign-in (any call made while signed out shows the user the sign-in link and code, waits, then runs once), the organization (`nxis_list_orgs`, `nxis_use_org`, `nxis_create_org`), the plan (`nxis_choose_plan`), the site (steps 4 to 11 and 13), credit packs and the autofill scope (inside `nxis_bulk_autofill` `submit`), connections, with the secret written to an env file (`write_env`) and tested (`nxis_test_connection`), the agreement (`nxis_accept_dpa`), and the hosted agents (`nxis_agents_status`, `nxis_agents_catalog`, `nxis_enable_agent`, `nxis_configure_agent`, `nxis_disable_agent`, `nxis_pause_agents`, `nxis_resume_agents`, `nxis_agents_brand`). On it, run no `nxis` command in the shell for these steps: use the tool
- **The CLI transport** runs the same steps as `nxis … --json` in your shell, with the commands in the step table. It is the fallback for a client that cannot elicit, and the route for the few things outside the guided setup that have no tool (the guardrails policy and stored transcripts, in **hosted-agents**)
- **The remote server** has the site tools of steps 4 to 11 and 13 only. The organization, the plan, connections, the agreement and the hosted agents run through the CLI there. The remote server is installed with the CLI, so the CLI is there on that transport
- **Never put a key in the chat or the project.** `nxis mcp install --remote` writes it into the agent's config and shows only a preview. Do not run `--print` unless the user asks to configure a client by hand. On a shared machine, prefer the local server, which holds no key
- **Exit codes and reasons are the same contract.** The CLI exits with one of four codes and prints one JSON object; an MCP tool failure comes back with `isError: true` and the same object (`ok`, `reason`, `error`)

| Exit | Means | Do |
|---|---|---|
| `0` | Done | Continue |
| `2` | Needs the user: a sign-in, a payment, a deploy or a choice | Relay the message and the `reason`, and offer the step that meets it (see "After a refusal"). **Never run the command again unchanged before that step is done** |
| `3` | Not authorized | On the CLI, `nxis login`, then run the command again. On the local MCP server, the next call shows the sign-in itself |
| `1` | Failed | Report the error as given |

**The local MCP server asks the user itself.** The plans (`nxis_choose_plan`), the agreement (`nxis_accept_dpa`, and `nxis_enable_agent` before it turns an agent on), the connection a hosted agent sends through (`nxis_enable_agent` with no `connection`), the credit packs and the autofill scope (`nxis_bulk_autofill` `submit`) are put to the user as a choice in a dialog. Creating an organization, an autofill submit, a real publish, turning the MCP server public, creating, binding, rotating or deleting a connection, routing actions to a webhook, listing in the NxisAI app, and turning on, changing (while it is on), turning off, resuming or rebranding a hosted agent each raise a yes-or-no dialog before anything is sent. A pause (`nxis_pause_agents`) is never asked about: it is the safe direction. **The dialog is the question: do not ask it in the conversation as well.** Tell the user in a line what the call is about to ask (the plan, the agreement, the connection), make the call, and act on what comes back. Ask in the conversation only what no dialog covers: the organization's name, which existing organization when there are several, the autofill mode (`existing`), which agent to turn on, a connection's address and name, and every value visitors read. A refusal comes back as `declined_by_user` or `cancelled_by_user`: nothing was done; stop, and do not call again unless the user asks.

A client that cannot ask returns `confirmation_unavailable`, with what the call would have done (`would_do`) and the equivalent `terminal_command`: put that decision to the user yourself as a structured choice, and on their pick run the command it names in the shell, as the step table's CLI column gives it, with `--json` and the flags their pick needs (`--yes` only once they said yes); from then on, use the CLI transport. Never start the server with `--allow-unconfirmed` on your own. A call made while the CLI is signed out shows the user the sign-in link and code in a dialog and runs once they have signed in; only a client that cannot show it returns `signed_out`, `session_expired` or `key_refused`, and then you run `nxis login` (step 1) in the shell, and the next call works without a restart.

**A tool refusal names its next call.** On the local server, a refusal from the organization and hosted-agent tools carries `next`: the tool call that meets it (`nxis_accept_dpa`, `nxis_create_connection` with `write_env`, `nxis_bind_mcp_action` with `enabled: true`, `nxis_enable_agent` again with `connection` …). An agent that is on but held back gets `next` the same way. Follow it, putting any decision in it to the user first, then make the refused call once more.

**After a refusal, offer the step that meets it, then retry once.** A refusal names the prerequisite that is missing, and on the local server its `next` names the call. Put the step that meets it to the user as a choice (with Cancel) unless a dialog of that step will ask it, do that step on their pick, then make the refused call once more, unchanged apart from what the step supplied (a `connection`, say). If it is refused again, stop and report both refusals; do not loop.

| `reason` | The step that meets it |
|---|---|
| `credits_exhausted` | The credit packs (step 8, "The balance"), or a narrower scope |
| `dpa_not_accepted` | The agreement (step 12, "The agreement"): `nxis_accept_dpa` on the local server |
| `connection_required` | A connection: reuse one, build a receiver here, or use an existing endpoint, with the secret written to the env file (step 9), then the enable again with `connection` |
| `records_missing` | Records: publish drafts, or generate the missing ones with their own plan and yes (step 8) |
| `actions_off` | The site's actions back on: `nxis_bind_mcp_action` with only `enabled: true` (`nxis actions on` on the CLI) |
| `site_not_verified` | Verification (steps 5 and 6) |
| `no_active_org` | The organization (step 2) |
| `sign_in_required`, `signed_out`, exit 3 | `nxis login` (step 1) |

**Pointing at another environment.** `--api <url>` or the `NXIS_API` variable points the CLI, and a local MCP server installed with it, at another NxisAI environment, for testing. A sign-in belongs to its environment, so the CLI asks for a new one there (`environment_mismatch`, exit 3). `--api production` goes back. The read-back checks (step 8's record check, step 14's types) need that environment's own site MCP endpoint, since `nxis types` and `nxis query` may still read production's: if `nxis types` fails with `site_mcp_not_public` right after `mcp public on`, that is the cause, not the setting.

## The commands, step by step

Use the MCP column on the local MCP server, and the CLI column on the CLI transport. On the remote server, use the MCP column where a tool is not marked "Local", and the CLI column for the rest. Pass `--json` on every CLI command. Each command acts on the current organization and site (`--org`, `--site <id|domain>`, or the ones saved by `orgs use` and `sites create` or `sites use`); MCP tools take the site id or domain as `site`. "Local" marks a tool only the local server has.

| Step | CLI | MCP tool |
|---|---|---|
| 1. Sign in | `nxis status`, `nxis login` | Local: no tool; the first call made while signed out (`nxis_list_orgs`) shows the sign-in link and code |
| 2. Organization | `nxis orgs list`, `nxis orgs use <id\|name>`, `nxis orgs create --name … --website …` | Local: `nxis_list_orgs`, `nxis_use_org` (`org`), `nxis_create_org` (`name`, `website`, `industry`) |
| 3. Plan | `nxis plans`, `nxis subscribe <tier>`, `nxis credits`, `nxis credits packs`, `nxis credits buy <sku>` | Local: `nxis_choose_plan` (the plans in a dialog; a paid one opens its payment page and waits). Packs: inside `nxis_bulk_autofill` `submit` (step 8), when a run needs them |
| 4. Site | `nxis sites list`, `nxis sites use <id\|domain>`, `nxis sites create <url> [--name …]` | `nxis_list_sites`, `nxis_create_site` |
| 5. Verification tag | `nxis sites verify --token` | `nxis_verify_site` `mode: token` |
| 6. Verify | `nxis sites verify --check` | `nxis_verify_site` `mode: check` |
| 7. Crawl | `nxis crawl submit [<sitemap-url>] --wait`, `nxis crawl status --wait` | `nxis_crawl_sitemap` `mode: submit`, then `status` |
| 8. Structured data | `nxis autofill plan [--pattern '/services/*']`, `nxis credits` (the balance), `nxis autofill submit --yes --wait`, `nxis autofill status`, `nxis publish` (counts, then stops), `nxis publish --yes`, `nxis types`, `nxis query <type>` | `nxis_bulk_autofill` `plan` / `submit` / `status` (local: `submit` asks the scope and offers packs when the balance is short), `nxis_publish_entities`, `nxis_list_types`, `nxis_query` |
| 9. MCP server | `nxis mcp settings`, `nxis mcp public on`, `nxis actions on`, `nxis connections list`, `nxis connections create --name … --url … --write-env .env.local`, `nxis connections test <name>`, `nxis actions bind <action\|default> --connection <name> \| --self-page` | `nxis_mcp_settings`, `nxis_enable_public_mcp`, `nxis_bind_mcp_action` for the page (only `enabled: true` turns actions back on). Local: `nxis_list_connections`, `nxis_create_connection` with `write_env`, `nxis_test_connection`, `nxis_bind_connection` |
| 10. Discovery files | `nxis discovery files`, then `--write [--out <dir>]` | `nxis_aio_files`, then write the files yourself |
| 11. Site tag | `nxis sites tag status`, `nxis sites tag issue --domain … --webmcp-mode browser` | `nxis_site_tag` `mode: status`, then `issue` |
| 12. Hosted agents | `nxis agents status`, `nxis agents catalog --by-fit`, `nxis agents catalog <id>`, `nxis agents enable <id> [--<setting> …] [--connection <name>]`, `nxis agents configure`, `disable`, `pause`, `resume`, `nxis agents brand --name … --logo … --accent … --privacy-url …`, `nxis agents dpa`, `nxis agents dpa accept --yes [--site <id> --entity …]`; the rest in **hosted-agents** | Local: `nxis_agents_status`, `nxis_agents_catalog` (`by_fit`, or `agent`), `nxis_enable_agent` (`agent`, `settings`, `connection`), `nxis_configure_agent`, `nxis_disable_agent`, `nxis_pause_agents`, `nxis_resume_agents`, `nxis_agents_brand`, `nxis_accept_dpa` |
| 13. NxisAI app | `nxis sites list-in-app --preview`, `nxis sites name <name>`, `nxis sites list-in-app` | `nxis_list_in_app` (`preview: true` first), `nxis_set_site_name` |
| 14. Final check | `nxis agents status`, `nxis types` | `nxis_list_types` for the records. Local: `nxis_agents_status` |

## The host the site deploys to

No step names a host. Where one matters (what counts as production, which variables hold a generated URL, where static files go), find the answer in the project:

| Question | Netlify | Vercel | Cloudflare |
|---|---|---|---|
| How do I know it is this host? | `netlify.toml`, `.netlify/` | `vercel.json`, `.vercel/` | `wrangler.toml`, `wrangler.jsonc` |
| What counts as production? | `CONTEXT=production` | `VERCEL_ENV=production` | The production branch; `CF_PAGES_BRANCH` on Pages |
| Which variables hold a generated host, never the canonical one? | `URL`, `DEPLOY_PRIME_URL` | `VERCEL_URL` | `CF_PAGES_URL` |
| Where do static files go? | The publish directory in `netlify.toml` | The framework's `public/` | The build output or assets directory |

For any other host, ask the user those four questions rather than guessing.

### A host that isn't production

Sometimes the host being onboarded is not the one production serves: a tunnel to a local server, a deploy preview, a branch deploy, a staging domain. It is set up as its own site, so it gets its own verification META, site tag token and discovery entries, and **none of them may reach the files that ship to production**: the next production deploy would carry the test host's verification, advertise its MCP server to every agent that reads the discovery files, or break the production tag.

**Tell which it is, before step 5.** Find the project's canonical origin: a site URL variable (`NEXT_PUBLIC_SITE_URL`, `SITE_URL`, `PUBLIC_SITE_URL` in a committed env file or the code), the framework's config (`site` in `astro.config.*`, `metadataBase`, `siteUrl`, `baseURL`), the `<loc>` host of the production sitemap, or the production domain in the host's config. If the host from step 4 is not that origin (or a host in the host table's "generated" row, or a tunnel), treat it as a test host. If the project names no origin, ask the user whether this host is production.

**For a test host:**

- **Write its values only where that host is served from.** The verification META content and the site tag token go into that host's own configuration: a gitignored env file the local server reads (`.env.local`, `.env.development.local`, `.dev.vars`), or the host's environment for that one context (a branch deploy's or preview's variables). Discovery entries go where only that host serves them: a gitignored directory the local server serves, or that context's own build. With the CLI, `nxis discovery files --write --out <dir>` writes into that directory, never the default `public/` or `static/`. Check the file is ignored (`git check-ignore -q <path>`) before writing it
- **Ask before touching any committed, shared file** (a layout, `public/llms.txt`, `agents.md`, the catalogs, a committed env file), and say in the question that the file ships to production. Offer: change it, write the test host's values only in its own configuration instead, or Cancel. If the project reads the tags from a variable already, set the variable; if it hard-codes them, the first change is to read them from a variable, and that is a change to a shared file, so it is asked first too
- **Never make the code pick the token or the verification tag by host** (a branch on the request's host in a layout or a head component) without asking: it ships both tokens to production and changes what production serves
- **List what you changed for the test host, and how to undo it**, at the end of the run: each file and variable with the value's name (never a secret), each connection created for the tunnel (`nxis_delete_connection` removes one), and the site itself (removed in the NxisAI dashboard). For a gitignored file, deleting the lines undoes it; for a committed file the user agreed to change, give the revert

### When a tunnel or host answers with an error

A 502 or 404 from a tunnel, `site_unreachable`, or a connection test's `unreachable` or `bad_response` says where the request stopped, not why. **Before concluding anything, find where the site really runs**, and never from a dev script's default port alone:

- **The running server.** List listening ports (`lsof -nP -iTCP -sTCP:LISTEN` on macOS and Linux, `ss -ltnp` on Linux, `netstat -ano` on Windows) and keep the project's own process (`node`, `next`, `vite`, `wrangler`, `netlify`)
- **The tunnel's own status.** ngrok's local API, `http://127.0.0.1:4040/api/tunnels`, lists each tunnel's public URL and the address it forwards to (`config.addr`). For `cloudflared` or another tunnel, use its status command or its config
- **The project's dev script and env.** The port in `package.json`'s script, and any `PORT`, `NEXT_PORT` or similar in the env files it reads, which override the default

Then check in order, and stop at the first that fails:

1. Does the public URL answer, and who answers it? A body that is the tunnel's own error page means the tunnel is up and the server behind it is not reachable
2. Does the tunnel's target answer locally (`curl -sI http://localhost:<target-port>/`)?
3. Does the target match the port the server really listens on?
4. Is the server up at all?

Only then suggest one specific fix, start the server or point the tunnel at the server's real port, and say what you checked and what each check showed. Don't restart a server or tunnel the user runs without asking: say which one and why. A connection test's `unreachable` that names a tunnel or proxy as the answerer (a newer CLI reports which, and the body may be the tunnel's error page) is the same case: the tunnel is up, the server behind it isn't, so run the same checks.

## The pattern

Work in order. Steps 7 onward silently do nothing until step 6 has passed, and the run stops twice for the user to deploy (steps 5 and 11).

### Step 1 — Sign in

On the CLI, run `nxis status --json` first. It never fails for "not signed in"; it reports `signed_in`, the organizations, `active_org`, `active_site`, the `subscription` and the credits. Skip every step it shows is done.

On the local MCP server, there is no status call and no sign-in step: make `nxis_list_orgs` the first call. Made while signed out, it shows the user the sign-in link and code in a dialog, waits, and then runs. Say that it will, and do not relay the link a second time in the conversation. Its result is where things stand: the organizations and `current_org_id`. Whether there is a plan comes from `nxis_choose_plan` (step 3), and the site from `nxis_list_sites` (step 4).

On the CLI, or when the server answers `signed_out` (its client could not show the sign-in), run `nxis login` yourself. It prints a URL and a short code, then waits. **Relay both exactly as printed**, tell the user to check that the code on the page matches, and wait for the command to finish; do not ask the user to run it. The URL works from any device, a phone included, when this machine has no browser. Never ask for a password, a Google code or a one-time code in the conversation; if the user offers one, tell them not to.

### Step 2 — The organization

**When the user's request names an organization**, as in `… set up this site on NxisAI in organization "Acme" (<org id>)`, use that one and ask nothing: once signed in, find it among the organizations (by its id when the request gives one, otherwise by its exact name; if more than one has that name, ask which) and make it current. If none matches, or `nxis orgs use` (`nxis_use_org`) refuses with `org_not_found`, the signed-in account can't see it: **stop**, tell the user which account is signed in (the `email` from `nxis status`) and that they need to sign in with an account that owns or belongs to that organization (`nxis logout`, then `nxis login`). Never create an organization in that case, and never carry on in another one.

Otherwise, put the organization to the user as a structured choice, every time: each existing organization by name (the current one first, marked current), then **A new organization**, then **Cancel**. Never assume the existing one: a user onboarding a new business, or testing, needs a new one, and an existing organization's plan, credits and agreement carry over to everything in it. For **A new organization**, ask what it should be called (the site's own name is usually right; the project directory usually is not) and create it. With none, offer only **A new organization** and **Cancel**. An empty organization left from a browser signup is reused (`reused: true`) rather than duplicated.

- **Local MCP server:** `nxis_list_orgs` gives `orgs`, each with `current`, and `current_org_id`. Pick another with `nxis_use_org` (`org`: the id, or its exact name). Create one with `nxis_create_org` (`name`, and `website` and `industry` when the user gave them); the server asks the user's yes in a dialog, so don't ask it again. The choice is read on every call, so the next call acts on the new organization with no restart. `org_pinned` means the server was started with `--org`: it keeps acting on that one, and the user changes the server's config to switch
- **CLI:** `nxis status --json` lists them; `nxis orgs use <id|name>`, or `nxis orgs create --name "…" --website "https://…"`

On the remote server the organization is the key's: a permission error on every call means the key belongs to another one.

### Step 3 — Choose a plan

On the CLI, skip this if `status` shows a live `subscription`.

**On the local MCP server**, call `nxis_choose_plan`. It says so and changes nothing when the organization already has a plan; otherwise it shows the user the plans, with each one's price, interval and credit grant, in a dialog. A free plan starts at once; a paid one opens its payment page and the call waits until the payment clears. Do not put the plans in the conversation first, and do not ask again afterwards: report what it returns. Credit packs come later, when a billed run needs them (step 8). `declined_by_user` or `cancelled_by_user` means no plan was chosen; `confirmation_unavailable` means the client cannot ask, so continue on the CLI as below.

**On the CLI**, run `nxis plans --json`: each plan has `tier`, `name`, `price`, `interval`, `credits` and `lifetime` (free plans grant their credits once).

Put the plans to the user as a structured choice (the harness's affordance, or a numbered list, then stop), with the price, the interval and the credit grant of each in the message that asks, and add **Cancel**. Offer, in this order: the free plan; the free plan plus a credit pack; each paid plan. For the second, list the packs from `nxis credits packs --json` (`sku`, `credits`, `price`) so the pick names one. Wait for an explicit pick, then run what it names yourself.

- Never choose a paid plan or a pack for the user. "Set me up", "do whatever you need" and silence are not consent to be charged
- Free: `nxis subscribe free`
- Paid: `nxis subscribe <tier>` prints the amount, opens the payment page and waits. Payment is the user's: card details go to the payment page and never to you, the CLI or this conversation. Say what it is waiting for, and do not claim it went through until it exits `0`. With no browser here, `--no-open` prints the link to relay
- Free plus a pack: `nxis subscribe free`, then `nxis credits buy <sku>` with the pack they picked, which opens the payment page and waits the same way. A pack needs a plan first: `no_active_plan` means the order was wrong; subscribe first

| Exit 2 `reason` | Do |
|---|---|
| `choose_plan` | Put the options to the user, as above. `nxis signup` returns them in `options` |
| `payment_pending` | **Do not run `subscribe` again**: a second run opens a second checkout and can charge twice. Wait for the user, then `nxis status` |
| `no_active_plan` | `nxis subscribe free` before the pack |
| `topup_pending` | The pack's payment hasn't landed yet. **Do not buy again**: it charges twice. Wait for the user, then `nxis credits --json` |
| `sign_in_required` | `nxis login` |

### Step 4 — Create the site, or use one that exists

Run `nxis sites list` (`nxis_list_sites`). If the site is already there, `nxis sites use <id|domain>` and carry on from the first step it has not done.

Otherwise **ask the user for the URL** rather than inferring it from the repository: a monorepo, a staging domain or a subdomain are easy to guess wrong, and the host is fixed at creation. `www.example.com` and `example.com` are different sites; create it on the host production serves. When the user means a tunnel, a preview or a staging host instead, that is a test host: follow "A host that isn't production" from step 5 on. Then `nxis sites create <url> [--name "…"]` (`nxis_create_site` with `url`; name it later with `nxis_set_site_name`). The CLI saves it as the current site. Keep the site id: every MCP call after this takes it.

### Step 5 — Write the verification tag in, then stop for a deploy

`nxis sites verify --token` (`nxis_verify_site`, `mode: token`) returns the META tag: `tag`, with its `name` and `content`. Add it to the site's HTML head, where the project already keeps meta tags (a layout, a template, a head component), rather than adding a new mechanism. For a test host, put its content only in that host's own configuration (see "A host that isn't production"), and ask before changing a shared layout.

Then **stop and tell the user to deploy to production**, and say why: the verifier fetches the site's own URL, so a deploy preview or branch deploy on a generated host never verifies, however correct the tag in it is. For a test host, the deploy is to that host itself: the context it serves, or the local server behind the tunnel, restarted so it reads its env file. How to reach production is the host's business (a merge to the production branch, a promote, a production deploy command); if the project has skills for its host, send the user there.

Write only the verification tag now. The site tag comes in step 11, once the site is verified and has data to serve.

### Step 6 — Verify, once it is deployed

`nxis sites verify --check` (`nxis_verify_site`, `mode: check`).

`site_not_verified` (exit 2, with `verifier_reason`) almost always means the deploy has not landed yet. Say that, and check again when the user says it is live, or 20 to 30 seconds apart, never in a tight loop. If it keeps failing after a production deploy, check first whether what was deployed was a preview. `site_unreachable` means the site cannot be fetched at all; waiting will not help, so the site has to be deployed at its address first. For a test host behind a tunnel, find where the site really runs before suggesting anything: see [When a tunnel or host answers with an error](#when-a-tunnel-or-host-answers-with-an-error).

Do not continue until this passes. Ingestion is gated on verification, so the steps after it report success and produce nothing.

### Step 7 — Check the site names its own host, then crawl the sitemap

Step 8 bills for every resource the crawl finds and records each URL as a fact about the business, so a wrong host found now is a file change, and found later is a corpus to regenerate. Before submitting:

1. **The live sitemap's `<loc>` entries are all on the step 4 host.** A generated host there (`*.netlify.app`, `*.vercel.app`, `*.pages.dev`) means the canonical origin comes from a variable in the host table. `nxis crawl submit` checks this itself and refuses with `sitemap_off_host` (exit 2), with no way to skip it. On MCP, fetch the sitemap and check it yourself
2. **The source has no absolute URLs on another host**, in metadata, structured data, canonical links or config. Email domains are not URLs; leave them alone
3. **The canonical origin is a constant in the code**, overridable by an environment variable, not a generated-host variable and not only a dashboard setting. A local dev server reached through a tunnel may build URLs from the request instead: the `<loc>` and canonical scheme must match the site's (`https://`, not `http://`), and the server must accept the tunnel's host for static files too

If any check fails, stop, show the user what you found, and fix it before the crawl. It is a code change and a deploy.

Then crawl. The sitemap is usually the root plus `/sitemap.xml`; check the project first, since many frameworks put it elsewhere. If the site has none, say so and stop rather than inventing URLs.

- **CLI:** `nxis crawl submit [<sitemap-url>] --wait` polls every 20 seconds until `COMPLETE` (exit 0) or `FAILED` (exit 1, with the error). `crawl_running` (exit 2) means the wait ran out and the crawl carries on: run `nxis crawl status --wait`
- **MCP:** `nxis_crawl_sitemap` with `mode: submit` and the URL; `QUEUED` means accepted, not done. Poll `mode: status` every 20 to 30 seconds through `QUEUED` and `PROCESSING` to `COMPLETE`. On `FAILED`, report the error verbatim

Do not move on while it runs: step 8 counts what the crawl found, so planning against a half-ingested site quotes one number and bills another. Report progress rather than promising a time.

### Step 8 — Generate structured data, then publish it

This is the step that **spends the user's credits**. Everything before it is free and reversible.

**Plan first.** `nxis autofill plan --existing import_and_complete` (`nxis_bulk_autofill`, `mode: plan`, `existing: import_and_complete`). It returns `planned_count` (what this plan would cover, after any scope), `resource_count` (the site's resources, or the media type's, before a path scope), a `by_media` breakdown, `pattern_count` for a path, and the `existing` mode. **The number to show and approve is `planned_count`**; `resource_count` ignores a `--pattern`, so it overstates a scoped run. A plan without `planned_count` (an MCP tool that predates it) gives the path's count in `pattern_count`; use that for a path, never `resource_count`. With both a media type and a path, `planned_count_is_upper_bound` is true: say "at most". On MCP, pass `existing` on every call, `plan` and `submit` alike, since the tool's own default is `generate`.

| `existing` | What happens | Cost |
|---|---|---|
| `import_and_complete` (**the default to offer**) | Each page's own JSON-LD is kept; AI generates only what it lacks, such as actions from its forms | Varies |
| `import` | Only the JSON-LD the pages publish, no AI; a page with none gets nothing | Fixed per page: `import_cost_per_resource_milli` |
| `generate` | AI writes everything; the site's own JSON-LD is ignored | Varies |

Look at the project first: if its templates emit `<script type="application/ld+json">`, say so and which kinds of record. When that JSON-LD already publishes the site's actions (a `potentialAction` its forms serve), recommend **Import only**: completing would generate a second action from the same form, at model cost.

**Find the path clusters.** A path cluster is a group of pages under one path, written with a trailing wildcard: `/services/*`, `/products/*`, `/blog/*`. Read them from the crawled sitemap's `<loc>` entries (or the project's routes): group the URLs by their first path segment and keep the groups with several pages. A single page (`/about`, `/services/roofing`) is not a cluster; the plan has no count for it and the submit refuses it (`scope_not_counted`). For each cluster worth offering, `nxis autofill plan --existing … --pattern '/services/*'` (`pattern`), and take its count from `planned_count`. Quote the pattern in the shell, so the `*` reaches the CLI.

**Read the real balance.** On the CLI, `nxis credits --json` returns `remaining_milli`, the organization's balance in thousandths of a credit (divide by 1,000 to show it). Use that, not the plan's `credits_remaining`, which can report the plan's allowance rather than what is left. On the local MCP server, don't read it first: `nxis_bulk_autofill` `submit` reads the real balance itself and shows it in its dialog, so ask the mode with `planned_count` alone and don't quote `credits_remaining` as the balance.

**Put the decision to the user as a structured choice, never a question in prose**, with `planned_count` (and, on the CLI, the balance):

1. **Import and complete** (recommended): keep what the site publishes, generate what is missing
2. **Import only**: no AI, at the fixed price per page
3. **Generate everything**: AI writes all of it
4. **A path cluster**: each cluster from above as its own option with its count (`/services/*`, 24 pages), or one media type (`--media-type HTML|IMAGE|VIDEO|AUDIO`, `media_type`) with its count from `by_media`. Combines with any of the above
5. **Cancel**

**On the local MCP server, the dialogs take the scope and the packs.** `nxis_bulk_autofill` `submit` with no `pattern` or `media_type` shows the user the site's path clusters, each with its count, beside all pages; when the balance is short it offers the credit packs and waits for the payment; then it asks a yes with the count it will run. So in the conversation ask only the mode (1 to 3, with `planned_count`), leave out options 4 and the packs, and pass no scope unless the user already named one. Do not ask the scope, the packs or the yes again in the conversation.

Use the harness's structured-choice affordance if it has one; otherwise a short numbered list, then stop. Consent asked in prose reads as answered at the first "yes", and the narrower options are never seen. If they pick another mode or a narrower scope, plan again with it and show the new `planned_count`, so the number they approve is the number that runs. Do not estimate a total cost for AI generation; the plan leaves it out on purpose. For `import` only, give the fixed price, the count and their product.

**The balance.** On the local MCP server, `submit` checks it and offers the packs itself; skip the rest of this part unless it returns `confirmation_unavailable` or `credits_exhausted`. On the CLI, before the submit, compare the balance with the plan:

- **Short.** `remaining_milli` is zero or below, the plan says `quota_exceeded`, or (for `import`) the count times `import_cost_per_resource_milli` is more than `remaining_milli`. Do not submit: a batch started into an empty balance pauses at once
- **Maybe short.** The count is large next to the balance (a free plan's one-time grant against a full site, say). Say the batch may stop partway

Either way, offer a structured choice: each pack from `nxis credits packs --json`, with its `credits` and `price`; a narrower path cluster, with its count; and Cancel ("go ahead anyway" too, when it is only maybe short). On a pack, run `nxis credits buy <sku>` yourself: it opens the payment page (`--no-open` prints the link to relay) and waits until the credits land. Say what it is waiting for, and do not claim the payment went through until it exits `0` with the new `remaining_milli`. `topup_pending` (exit 2) means the payment hasn't landed yet: **never buy again**, which charges twice; wait for the user, then `nxis credits --json`. Then read the balance again and continue with the submit the user approved.

**Submit once, on an explicit yes, with exactly what was approved.**

- **CLI:** `nxis autofill submit --existing … [--media-type …] [--pattern …] --yes --wait`. `--yes` says the user has seen and approved the plan; never pass it otherwise. Without it, in a shell with no terminal, it exits 2 `confirmation_required` with the plan
- **MCP:** `nxis_bulk_autofill`, `mode: submit`, with the same `existing` (and the scope, if the user named one in the conversation), then poll `mode: status` with the `batch_id` every 20 to 30 seconds. On the local server the user's answers in its dialogs are the approval

**Never submit twice.** It is a billed write. On a timeout or a dropped connection, follow the batch instead:

| What you see | Do |
|---|---|
| `submit_unconfirmed` (CLI, exit 2) | The submit may have started a batch. Follow `batch_id` if given (`nxis autofill status --wait`), or look with `nxis autofill status --recent` |
| `started: false` | A batch was already running; nothing new was charged. Follow the one it names |
| `nothing_planned`, `scope_not_counted` | Nothing was submitted. Check the crawl finished, or offer a path cluster the site has instead of a single page |
| `credits_exhausted` | Nothing was submitted. Offer the packs as in "The balance", then submit once more on the user's pick |

**A partial batch is not a failed run.** `PAUSED` (`autofill_paused` on the CLI, exit 2) means credits ran out partway, and it will not advance on its own; do not submit again to resume it. `COMPLETE` with many `failed` can mean the same: the credits ran out (the balance may end slightly negative), or those pages hit a quota. `nxis credits --json` shows the balance. Either way the completed pages are drafts: publish them and finish the run, then say how many of how many are live, which limit stopped the rest and what would lift it. Stop early only if **zero** pages completed.

**Publish what was generated.** Autofill produces drafts, and a draft serves nothing. Publishing needs no consent gate of its own, since the user agreed to generate this data, but it changes what the site serves publicly, so say that it happened and how many.

- **CLI:** the first `nxis publish` for an organization creates an MCP access key for it, kept in the OS keychain. Say so and ask before that first publish. `nxis publish --json` without `--yes` counts what would go live and exits 2 `confirmation_required` with `published_count`; then `nxis publish --yes --json`. Do not count with `--dry-run`: before the key exists, the global `--dry-run` only prints the key request it would send
- **MCP:** `nxis_publish_entities` with `dry_run: true` to count, then without

Afterwards report `published_count`. `skipped_disabled_count` being most of the batch, or equal to it, is normal. A published count of zero after a successful batch means it produced nothing; check before reporting success.

**Check the records carry what agents filter on.** Once step 9 turns the MCP server public, `nxis types` and `nxis query <type> --limit 10` on the two or three main types (`nxis_list_types`, `nxis_query`) show them. Report, without changing anything: businesses typed only `LocalBusiness` or `Organization` where a subtype fits (`Electrician`, `Restaurant`), and business records without `address.addressLocality`. If either shows up, say how many records and offer to regenerate them; that is a second billed autofill and needs its own yes.

### Step 9 — Turn on the site's MCP server

Read first: `nxis mcp settings` (`nxis_mcp_settings`). On a rerun, or for a site someone configured in the dashboard, report what is on and change only what differs from what the user asked for. Never turn off something you did not turn on.

Then `nxis mcp public on` (`nxis_enable_public_mcp`). This makes the published records queryable without a key, and prints the endpoint. It is the point of everything above, and what the hosted agents that answer from the site's records (step 12) read.

**Routing actions is optional; skip it on most first setups.** An action that runs on the site's own pages (its booking form, its quote form) stays there: `nxis actions bind <action|default> --self-page` (`nxis_bind_mcp_action`). When the user wants submissions to reach their own servers instead (a booking system, a quote inbox), route them through a **connection**: a name, an https address and one signing secret, shared by every action and hosted agent that sends there.

1. `nxis connections list` (`nxis_list_connections`). Reuse one that already points at the right address
2. **Otherwise, a choice.** Look in the project for a receiver first: a handler that verifies `x-nxis-signature` or reads `NXIS_ACTION_SECRET`. A new site usually has none. Then put it to the user as a structured choice, and stop:

   > 1. **Build one in this project**: a route here that receives submissions and checks they come from NxisAI; you choose where they go (an email, a webhook, a database)
   > 2. **An existing endpoint**: an https address on your servers that already takes them
   > 3. **Cancel**

   **Build** comes first when the project has no receiver; with one, its address comes first as **An existing endpoint**.
   - **Build one in this project.** Hand off to **action-binding** step 6, with its host reference for the framework ([Next.js App Router](../action-binding/references/hosts/nextjs.ts), [Netlify Functions](../action-binding/references/hosts/netlify.ts), [Vercel Functions](../action-binding/references/hosts/vercel.ts), [Cloudflare Workers](../action-binding/references/hosts/cloudflare.ts), [Express or Fastify](../action-binding/references/hosts/node.ts), sharing [`receiver.ts`](../action-binding/references/hosts/receiver.ts), [`bookings.ts`](../action-binding/references/hosts/bookings.ts) and [`submissions.ts`](../action-binding/references/hosts/submissions.ts); a static export, `output: "export"`, gets the host's function, since route handlers aren't deployed). Ask where submissions go and write `deliver()` for that. A receiver that takes bookings gets availability and holds by default: its check answers the open windows with `open` counts and a short `hold`, and a commit honors the hold. Set `calendar` in `submissions.ts` from the business's hours, time zone and seats per window, asking the user (offer the published opening hours as a choice), and give it the shared store its host file names before production. Then come back: derive the address from the site's verified host and the reference's route (`https://example.com/api/nxis/action`), show it, and use it only on the user's yes. Create the connection as in 3, into the env file the handler reads locally (`.env.local` for Next.js, `.env` for `netlify dev` or a Node server, `.dev.vars` for `wrangler dev`). Once it is reachable, test it: `nxis_test_connection` with the connection's name (`nxis connections test <name> --json` on the CLI) sends a signed check call (see **hosted-agents** step 4 for its verdicts). The references answer checks, so an `ok` from one built here should also say `answers_checks: true`; `false` means the check path isn't wired, so look at the receiver before going on. A receiver that takes bookings is then verified against the booking contract (below). Reachable means deployed, which on a first setup can ride on the deploy in step 11, or behind an https tunnel to a local server that serves the route; plain `next dev` doesn't serve Netlify functions, `netlify dev` does. On a CLI without `connections test` (`nxis --help` doesn't list it), say there is no way to send a signed call from here, and that the first real submission after the deploy shows whether it works. Bind (5) once it is deployed, or say that submissions fail until it is
   - **An existing endpoint.** Ask for the https address that receives the submissions. Never invent it

   **A booking receiver built or adopted here must answer the booking contract.** This applies to one you build and to one found in this project in 2 that the connection will use for bookings. The contract's source of truth is [`bookings.ts`](../action-binding/references/hosts/bookings.ts), the action-binding reference (its header and [Check answers, availability and holds](../action-binding/SKILL.md#check-answers-availability-and-holds)), not the project's existing form or calendar code:

   - A **day check** (`"nxis:mode": "check"` with `date` and no window) answers that day's `windows`, each with `start`, `end` and `open` (seats left, `0` when full), in the business's time zone, and holds nothing
   - A check for **one window** (`start`, or `date` and `window`) holds a seat while it has one and answers `hold: { token, expires_at }`; a held seat counts as taken for everyone else. The same check with its live `hold_token` gets the same hold back, not "taken"
   - A **commit** with `hold_token` books the held seat, and refuses with `409` and `code` `hold_expired`, `hold_unknown` or `taken`, with `alternatives`. A commit without a hold still books a free seat, once per `Idempotency-Key`

   **Verify it, then fix what's missing.** Once it is reachable, run a booking check: `nxis_test_connection` with `connection` and `action: "booking"` (`nxis connections test <name> --action booking --json`). Require `answers_checks: true` and `returned_windows: true`. The test's check names a date alone, so `returned_hold` is `false` even from a receiver that holds; accept `returned_hold: true` when the test reports it, and otherwise, with holds on (the reference's default, `holdSeconds` in `calendar`), verify them in the receiver's own tests: the [`hosts.test.ts`](../action-binding/references/hosts/hosts.test.ts) booking cases (a hold issued, re-checked, honored, expired and unknown, and a held seat taken for a second visitor), copied with the reference or added to the project's tests for an adopted receiver. When `returned_windows` is `false`, or a hold case fails, bring the receiver's check and commit up to `bookings.ts`: copy it, or fit the project's calendar and store to its `windows`, `hold` and `409` codes, keeping the project's `deliver()`, quote handling and signature check as they are. For an adopted receiver, put that change to the user first; it is their code. Run its tests, redeploy (or let the local server reload), and test again until `returned_windows` is `true`. Don't turn Booking on against it before then, or say plainly what visitors get without it (**hosted-agents**, step 6). On a CLI whose `connections test` has no `--action` or doesn't report `returned_windows` (`nxis connections test --help`), offer `nxis update`, and meanwhile read the receiver's check code against `bookings.ts` and say you couldn't test it

   Either way ask for a name (the site's name or "Website" is usual). `--default` (`make_default`) makes it the site's default, so ask first
3. **Create it with the secret written straight into the project's env file**, so it never enters the conversation. On the local MCP server, `nxis_create_connection` with `name`, `url` and `write_env` (and `env_name` when the receiver reads another name); the server asks the user's yes in a dialog. On the CLI:

   ```
   nxis connections create --name "Website" --url https://… --write-env .env.local --json
   ```

   Pick the file the receiving application already reads its local configuration from: `.env.local` by default, or `.env.development` where the project uses that (look for it, and for which one the framework loads). The variable is `NXIS_ACTION_SECRET` unless the receiver reads another name (`--env-name <NAME>`). Both check with git first and **refuse a file git doesn't ignore**, so a secret is never one commit away from the repository; if it refuses, tell the user the file isn't ignored and offer to add it to `.gitignore`, or pick an ignored one. It creates the file if needed, replaces only that variable's line, and reports `written_to`, the variable name and `secret_preview` instead of the secret. Never print, read back or repeat the secret, and never `cat` the env file. Tell the user the variable also has to be set in the host's environment for production; they copy it there from the file, not from you. `nxis_rotate_connection_secret` with `write_env` (`nxis connections rotate <name> --write-env …`) replaces it the same way, only when the user asks
4. **Without `write_env` the secret comes back.** The tool returns `signing_secret` when `write_env` is left out, so always pass it when the receiver is in this project. An older CLI has no `--write-env`, and a flag the CLI doesn't know is ignored: on the CLI transport, check `nxis connections create --help` lists it first. On such a CLI, or a server whose `nxis_create_connection` has no `write_env`, offer `nxis update` first; if the user declines, store `signing_secret` where the receiving application reads its configuration before replying (**action-binding** covers storing it and checking signatures), and never repeat it in the conversation or a summary
5. `nxis_bind_connection` with `action` and `connection` (`nxis actions bind <action|default> --connection <name>` on the CLI). A hosted agent is routed through a connection by `nxis_enable_agent` instead (step 12)

The hosted agents that send requests to the business (step 12) use the same connections.

### Step 10 — Write the discovery files

`nxis discovery files` (`nxis_aio_files`) returns `llms.txt`, `agents.md`, `.well-known/ai-catalog.json` and `.well-known/mcp/catalog.json`, with their paths. If there is no MCP endpoint in them, step 9 did not take; go back rather than publishing files that advertise a server that refuses every agent.

**Read what they say before writing them.** Every host, name and description must name the site from step 4. One that names the organization or another host is a defect: report it, and do not write it. Agents take these files as the site's own description.

**Check the project's own checks first.** Some projects lint or scan `public/` or static files in a build step or script and fail on strings these files carry (`schema.org`, the MCP host). If one would, tell the user which rule the files break and what change the project needs; do not edit the check yourself.

**Check the project serves `.well-known/`.** Some frameworks drop dot-directories from their output. If it needs configuration, make that change too, or tell the user.

**For a test host, not into the shared files.** The site's public root is committed and ships to production, so a test host's entries never go into its `llms.txt`, `agents.md` or catalogs without asking first, saying they ship to production. Write them only where that host serves them, as "A host that isn't production" says, and add them to the list of what changed for it.

**Write them into the site's public root, merging, never overwriting.**

- **CLI:** `nxis discovery files --write` merges into `public/` or `static/` when exactly one exists, or `--out <dir>` (the static directory from the host table). It keeps every existing catalog entry, title and section, adds only what is missing, refuses an invalid catalog, and prints a diff. Show the user the diff
- **MCP:** write the four files yourself, at the paths the response gives. Where a file exists: in `llms.txt`, keep their title, summary and sections exactly, and add the `## Agent access` section or only its missing links; in `agents.md`, add the NxisAI section if absent; in both catalogs, keep every entry, and update in place an entry that already points at this MCP endpoint rather than appending a duplicate. `ai-catalog.json` must stay valid JSON with an entry carrying a `url`. Show the diff for every file that existed

These go live with the deploy at the end of step 11.

### Step 11 — Write the site tag in, then stop for the second deploy

The site tag (`nxis.js`) puts the site's JSON-LD on every page, registers its actions as WebMCP tools, and, once step 12 turns them on, brings the hosted agents. It is issued only for a verified site.

1. **Decide the hosts.** The production host, plus `localhost` if the site is ever run locally (one entry covers every port). Never `*`. Deploy previews do not fit: a preview's host names one deploy, so say that previews show the site without the tag. For a test host, its token is its own site's, for that host (and `localhost` behind a tunnel)
2. **Read before issuing.** `nxis sites tag status` (`nxis_site_tag`, `mode: status`). If the token's claims already say `webmcp_mode: browser` and list those hosts, use it
3. **Otherwise issue.** `nxis sites tag issue --domain example.com --domain localhost --webmcp-mode browser` (`nxis_site_tag`, `mode: issue`, `domains`, `webmcp_mode: browser`). The site's own host is always added. `site_not_verified` (exit 2) sends you back to step 6. Re-issuing never breaks a live tag; the old token works until it expires
4. **Check the claims before writing.** `claims.webmcp_mode` is `browser` (with `none`, no tools register), `claims.site_id` is this site, `claims.domains` has every host from 1, and `claims.expires_at` is in the future. If any is wrong, do not write it; reissue
5. **Look for a check that scans the head** (forbidden strings such as the MCP host or the script name, in a lint or build step). If one would fail on the tag, tell the user which rule and what change it needs, rather than editing the check
6. **Write `script_tag` into the head**, beside the verification META, exactly as returned. For a test host, its token goes only into that host's own configuration, as the verification content did in step 5; ask before changing a shared layout, and never make the layout choose the token by host without asking. Put it behind a build-time switch that leaves it out, so the site can be compared with and without it. The token is public and domain-scoped, made to sit in page HTML, so it may be committed: say so, and say that the onboarding credentials are secrets and never go in the project. Add a comment with the expiry, the mode and the hosts

Then **stop and tell the user to deploy to production** (for a test host, to that host): the discovery files from step 10 and the tag go live together. Once it is live, a page's source has the tag, a `<script type="application/ld+json">` has been injected into the head, and `await document.modelContext.getTools()` returns the site's actions. If that list is empty on a site with forms, look at the token's mode first and its hosts second.

### Step 12 — Turn on the hosted agents

With the hosted agents on, the site tag draws the chat button and loads the agent harness from the NxisAI CDN by itself. **The site adds nothing else**: no package, no script, no model key, no relay. Changes reach the site within seconds. On the local MCP server every part of this step is a tool: `nxis_agents_status`, `nxis_agents_catalog`, `nxis_enable_agent`, `nxis_configure_agent`, `nxis_disable_agent`, `nxis_pause_agents`, `nxis_resume_agents`, `nxis_agents_brand` and `nxis_accept_dpa`, with connections and their test from step 9. Settings go by name in `settings` (`{"label": "Help"}`), as the catalog lists them. On the CLI transport, and on the remote server, the same steps are `nxis agents … --json` in the shell.

**First, check the project does not already host its own agent.** If it depends on `@nxisai/agent-harness`, mounts it in a layout or script, or `nxis mcp settings` shows `on_page_agent` on, the site runs a self-hosted agent (the **on-page-agent** skill). Do not enable the hosted page agent there: the site would show two agents. Say so, and let the user choose one. Likewise, if the project runs its own support, quote or booking agent (**support-agent**, **quote-agent**, **booking-agent**), ask before enabling the hosted one for the same job.

**Ask before enabling anything**: each agent puts something in front of visitors on every page of the live site. On the local server the enable's dialog is that question: say in a line what visitors will see, make the call, and don't ask it in the conversation too. On the CLI, ask it yourself.

Then follow **hosted-agents**, which covers every agent NxisAI hosts from its entry in the agent catalog. In short:

- **The page agent:** `nxis_enable_agent` with `agent: "page"` (`nxis agents enable page`); the server confirms in a dialog. Without branding the chat shows the default look, so ask the user for the name visitors see, a logo, an accent color and the privacy page, offering what the project has (the site's name, a square mark in its static files, the primary color from its CSS tokens, its privacy route). The logo and privacy page are full `https://` URLs on the production host, so the logo must be deployed. Then `nxis_agents_brand` with `name`, `logo`, `accent` and `privacy_url` (`nxis agents brand --name "…" --logo https://… --accent "#rrggbb" --privacy-url https://…`), with only the parts they choose; the server confirms it in a dialog
- **The other agents are reached through the page agent.** Quote, Booking and Support are handed off to from the on-page chat, so a request for only them still needs `page` live: offer it in the same choice, recommended (see **hosted-agents** step 6)
- **The other agents:** `nxis_agents_catalog` with `by_fit: true` (`nxis agents catalog --by-fit --json`) shows which fit the site and what each still needs; put them to the user as choices. For the one they pick, `nxis_agents_catalog` with `agent` lists its settings (`flags`, each with its `setting` name and limits), its prerequisites, `unmet`, and `enable_with`, the arguments `nxis_enable_agent` needs. Ask the user for every value visitors read (a label, example questions) and never invent one. An agent that sends requests to the business needs a connection (step 9), tested with `nxis_test_connection` before the enable, and again after it with `turn_on_checks: true` (`nxis connections test <name> --turn-on-checks --json`), so a receiver that answers checks has check support on for the agent's route: without it Booking takes requests instead of offering open times, and Quote skips the service-area check. Confirm `answers_checks: true` and an empty `check_support_off` (**action-binding**, [Turn check support on](../action-binding/SKILL.md#turn-check-support-on)). Leave `connection` out and the server asks the user which of the site's connections to use in a dialog, or returns `connection_required` with `next` when there is none; give it only when the user already chose one in the conversation. On the CLI it is `--connection <name>` on `enable`
- **A refusal is not a failure.** `connection_required`, `records_missing`, `dpa_not_accepted`, `credits_exhausted`, `actions_off` and the rest each name what the site needs, with `next`, the call that meets it, on the local server. Follow it (putting its decision to the user unless a dialog asks it), then make the refused call once more (see "After a refusal"); a refused enable says what it kept (`kept`), so the retry needs only what was missing. **hosted-agents** says how to resolve each. Never make the same call again unchanged
- **The agreement:** see below. Hosted agents answer no visitor until it is accepted
- **Read it back:** `nxis_agents_status` (`nxis agents status --json`) shows each agent in `agents` with its `state` (`live`, or what holds it back), the site-wide `kill_switch`, `live`, `go_live_blocked_by` and `verified_hosts`. `changed: false` means it was already set

The agent catalog and the hosted-agent tools need CLI 0.2.0 or later. A local server without `nxis_agents_catalog` among its tools is older: offer `nxis update` and a reload of MCP servers, or, if the user declines, run this step on the CLI transport. An older CLI answers `nxis agents catalog` with `unknown_command`: offer `nxis update`, or turn on the page agent and the Support Agent as that CLI does (`nxis agents enable page`, `nxis agents enable support --label "…"`, with a label the user gives).

**The agreement.** Hosted agents answer visitors only once NxisAI's data processing agreement for hosted agents is accepted. Accepting binds a legal entity, so it is the user's decision alone, and you never accept it without their explicit pick.

On the local MCP server, `nxis_enable_agent` offers the agreement in a dialog before it turns an agent on, when the agents wait on it; otherwise, once the user wants their agents to go live, call `nxis_accept_dpa` (with `site`). When the current version is already accepted it says so and changes nothing; otherwise it shows the user the version and its link in a dialog, and they choose who accepts: the organization, or the legal entity the site belongs to. Their answer is recorded as their acceptance. Do not put the choice below in the conversation as well; report what it returns. On `confirmation_unavailable`, use the choice below.

On the CLI, run `nxis agents dpa --json`: it gives the current `version`, its `url`, `accepted`, and `accepted_for` with `legal_entity` when the site belongs to another entity. If `accepted` is true, say so and move on. Otherwise put it to the user as a structured choice, with the version and the link in the message that asks, and ask them to read it:

1. **Accept for the organization**, for all of its sites: on this pick, `nxis agents dpa accept --yes --json`
2. **Accept for this site's legal entity**, when the site belongs to a different company than the organization: ask for the entity's exact legal name, then `nxis agents dpa accept --site <id> --entity "<name>" --yes --json`. When `legal_entity` is already set, offer only this option, with that name
3. **Cancel**: the agents stay on, waiting for the agreement, and reach no visitor

`--yes` records the user's own acceptance; pass it only on pick 1 or 2. `dpa_version_changed` (exit 2) means a newer version came out in between: show it and ask again. `dpa_entity_required` means the site belongs to another entity: offer option 2. If the CLI itself already asked the user and they accepted, it reports the acceptance; do not ask again.

Tell the user, briefly:

- **The kill switch.** `nxis_pause_agents` with no `agent` (`nxis agents pause`) refuses every turn on every hosted agent; with `agent` it names one; `tools: true` (`--tools`) refuses only turns that would use a tool that changes something; `reason` is what visitors are told. A pause needs no confirmation, so it works at once when the user asks. `nxis_resume_agents` (`nxis agents resume [<id>]`) lifts the one it names, or the site-wide one with none, after the user's yes in a dialog. An agent is held to the stricter of its own pause and the site's
- **The policy.** `nxis agents policy show` prints the guardrails policy and its version; `nxis agents policy set <file.json>` replaces it whole. It has no tool, and the setup doesn't need it: run it in the shell only when the user asks for a change
- **Transcripts.** Visitors' conversations are stored, redacted, for 30 days unless changed; `nxis agents transcripts settings` changes that or stores none (in the shell, when the user asks)

### Step 13 — Offer the NxisAI app

The NxisAI app lets people find the site from Claude and ChatGPT, browse its records and act on them. Being listed is the user's choice: **ask first**, and skip this step on a no.

1. **Preview it.** `nxis sites list-in-app --preview` (`nxis_list_in_app`, `preview: true`) changes nothing and returns `as_listed`: the title, categories, places and capabilities the app would show, with `next` notes. Show the user that
2. **Name it.** If the title is a domain, ask what people call the site and `nxis sites name "…"` (`nxis_set_site_name`)
3. **Who can see it.** With the MCP server public, anyone can browse it in the app. Say so, and change it only if the user asks
4. **List it.** `nxis sites list-in-app` (`nxis_list_in_app`). Act on each `next` note: *not actionable from the app* means its actions run on its own pages, so offer to route them through a connection (step 9, `nxis_bind_connection`); *no places* or *no specific type* points back to step 8's record check; *discovery files don't link the server* means step 11's deploy has not landed

It appears in the app within a few minutes. **mcp-discovery-publishing** checks it there.

### Step 14 — The final check

On the production site, once the second deploy is live:

- For each agent that sends to a connection (Quote, Booking) whose receiver answers checks, `nxis_test_connection` on it shows `answers_checks: true` and an empty `check_support_off`
- For Booking on a receiver built or adopted in this project, `nxis_test_connection` with `action: "booking"` shows `returned_windows: true`, and its holds pass the receiver's tests (step 9)
- `nxis_agents_status` (`nxis agents status --json`) shows the page agent, and every other agent turned on in step 12, with `state: "live"` in `agents` (a specialist live with `page` off is unreachable, so this check fails until `page` is `live` too), `live: true`, no `kill_switch` set, and the site's own origin (such as `https://example.com`) in `verified_hosts`. An agent in another state names what holds it back in `state_reason`; **hosted-agents** resolves it
- Loading a production page shows the chat button, with nothing added to the site but the tag
- `nxis types` (`nxis_list_types`) lists the published types with counts

If the button is missing: the tag is not in the deployed page, the page is on a host the token does not list, the page agent is not `live` in `agents`, a kill switch is on, or the origin is not in `verified_hosts`. Check in that order. Then give the user the site's MCP endpoint and what they can ask it, and offer **mcp-discovery-publishing** to confirm an agent can find the server through the discovery files.

## Best practices

- Ask the transport once, with local MCP first when the client can elicit (CLI first otherwise), and keep to it
- When a server dialog asked a decision, let the answer stand: don't ask it in the conversation too
- Find where things stand first (`nxis_list_orgs` on the local server, `nxis status` on the CLI) and skip what is done. A user coming back may need only the last few steps
- On the local MCP server, use the tools for every step, the organization and the hosted agents included; the CLI is the fallback for a client that cannot elicit
- Follow a refusal's `next`, the call that meets it, then retry once
- Ask for the site URL. Do not infer it from the repository
- Work out the host from the project before step 5, so you can say how to reach production rather than just "deploy"
- Say clearly when you are waiting on the user, and for what: a sign-in, a payment, or one of the two deploys
- Check the site names its own host before the crawl. It is the last point where fixing it costs nothing
- Run every command yourself, and put each decision the user owns (the plan, credits, the agreement, the autofill scope) to them as a structured choice, then stop and wait
- Put the plan choice and the autofill scope options in front of the user with the numbers, not after a yes to them
- On the CLI, read the balance from `nxis credits --json` before any billed run, and offer packs when it is short; on the local server, the submit's dialog does both
- Offer path clusters with their `planned_count`, not single pages, and show `planned_count`, never `resource_count`, for a scoped plan
- Write a connection's secret straight into a gitignored env file with `--write-env` (`write_env` on the local server)
- After a refusal, offer the step that meets it, then retry once
- Let a prompt the CLI or a server dialog already showed stand; don't ask it twice
- Read settings (`nxis_mcp_settings`, `nxis_site_tag` `status`, `nxis_agents_status`) before changing them, and report what was already in place
- Compare the onboarded host with the project's canonical origin, and keep a test host's tag, token and discovery entries in that host's own configuration
- Look for a self-hosted agent harness before enabling the hosted page agent

## Anti-patterns

- Choosing a paid plan, or reading "set me up" as consent to be charged
- Asking the plan, the packs, the autofill scope or the agreement in the conversation when the server's dialog asks it, or asking again after the user answered there
- Running `subscribe` again after `payment_pending`. It opens a second checkout
- Telling the user to run a command in their terminal. You run it; they choose
- Running `nxis orgs`, `nxis agents` or any other command in the shell for a step the local MCP server has a tool for
- Retrying a command that exited `2` before the step it waits on is done, or more than once after it
- Checking the balance against the plan's `credits_remaining`, or submitting into a balance you know is empty
- Buying a pack, or buying again after `topup_pending`, without the user's pick
- Accepting the data processing agreement, or passing `--yes` to it, without the user's explicit pick
- Showing, reading back or committing a signing secret, or writing it to a file git doesn't ignore
- Continuing past step 6 before verification passes. The steps after it look like they worked
- Telling the user to "deploy" when the host's default deploy is a preview. It will never verify
- Crawling a site whose sitemap or source names another host
- Asking for autofill consent in prose, passing `--yes` without an explicit yes to that plan, or submitting twice
- Estimating credit cost. The count and the balance are the honest figures
- Finishing without publishing. Drafts serve nothing
- Writing a discovery file that names anything other than the site, or overwriting one that exists
- Merging a tunnel's, preview's or staging host's MCP server into the committed discovery files, or its verification or site tag into a shared layout, without asking. They ship to production
- Making a layout or head component pick the token or the verification tag by host without asking
- Assuming the dev script's default port when a tunnel or host answers with an error, or restarting a server or tunnel the user runs without asking. Check where the site really runs first
- Writing a site tag token without checking its mode, hosts and expiry
- Enabling the hosted page agent on a site that already hosts `@nxisai/agent-harness`. Visitors get two agents
- Adding the agent harness, a script or a model key to the site for the hosted agents. The tag brings them
- Pasting a key into the chat or the project, or starting the MCP server with `--allow-unconfirmed` on your own
- Creating an organization, or carrying on in another one, when the user named one the signed-in account can't see
- Pinning a CLI version from memory. Use the installer or `@nxisai/cli@latest`
- Listing the site in the NxisAI app without asking
- Committing or deploying on the user's behalf unless they asked

## Worked example

**User:** "Set up my site on NxisAI."

**Step 0.** The agent is Claude Code, which supports MCP elicitation. Asked how to connect: 1. local MCP server (recommended: your decisions come to you as dialogs, and no key goes into my config), 2. CLI, 3. remote MCP. They pick 1. `nxis mcp install`, then `/mcp` to reload.

**Steps 1 to 3.** "A dialog will show you a sign-in link and code." `nxis_list_orgs`: the dialog shows them, they sign in, and the call returns no organizations. They call it "Example Outfitters": `nxis_create_org` with `name: "Example Outfitters"`, `website: "https://example.com"`, confirmed in its dialog. "Next, a dialog shows you the plans." `nxis_choose_plan`: they pick Free in the dialog, and it reports the plan with its one-time credits. Nothing about the plan is asked in the conversation.

**Step 4.** `nxis_list_sites` is empty. `nxis_create_site` with `url: "https://example.com"`. The project has a `netlify.toml`, so production is the production branch and previews run on `*.netlify.app`. `src/lib/site.ts` names `https://example.com` as the site's origin, the same host: not a test host.

**Step 5.** `nxis_verify_site` `mode: token`; the META tag goes into `src/layouts/base.html`.

> I've added the verification tag to src/layouts/base.html. Merge it to your production branch and tell me when it's live on example.com. A deploy preview won't verify, because the check fetches example.com itself.

**Step 6.** `nxis_verify_site` `mode: check` passes.

**Step 7.** The live sitemap lists every page on `example-shop.netlify.app`, because `src/lib/site.ts` reads Netlify's `URL`. Changed to a constant overridable by a variable; after their deploy the sitemap names example.com, and `nxis_crawl_sitemap` `submit`, then `status`, runs to `COMPLETE`.

**Step 8.** The product templates emit `Product` JSON-LD. `nxis_bulk_autofill` `mode: plan`, `existing: import_and_complete`: `planned_count` 340 (290 HTML, 50 IMAGE). The balance, the scope and any packs come in the server's dialogs, so only the mode is asked here:

> Ready to add structured data: 340 pages. I can't tell you the exact cost in advance; it varies per resource. Next, a dialog shows your balance, lets you narrow it to a group of pages, and offers credit packs if the balance is short.
>
> 1. **Import and complete** (recommended): keep your Product data, generate the rest
> 2. **Import only**: just your own JSON-LD, at a fixed price per page
> 3. **Generate everything**: AI writes all of it
> 4. **Cancel**

They pick 1. `nxis_bulk_autofill` `mode: submit`, `existing: import_and_complete`, no scope: the dialog offers all pages (340), `/products/*` (210) and `/guides/*` (130); they pick `/products/*`, then confirm 210 pages. Polled with `mode: status` to `COMPLETE`. `nxis_publish_entities` `dry_run: true` counts 210; the publish then asks its own yes in a dialog, and publishes 210.

**Steps 9 and 10.** `nxis_mcp_settings`: nothing on. `nxis_enable_public_mcp`, confirmed in its dialog. `nxis_list_types` shows `Store` and `Product`, and the sampled stores all have a locality. `nxis_aio_files` names example.com throughout; the four files are merged into `public/`, adding `## Agent access` to their existing `llms.txt`. The diff is shown.

**Step 11.** `nxis_site_tag` `mode: status`: no tag yet. `mode: issue` with `domains: ["example.com", "localhost"]`, `webmcp_mode: browser`; the claims check out, expiring in a year. `script_tag` goes into `src/layouts/base.html` behind `NXIS_TAG_ENABLED`, with a comment.

> Deploy once more: this puts the site tag and the discovery files live together. The token in the tag is public by design and fine to commit.

**Step 12.** No `@nxisai/agent-harness` in the project. They want the chat: `nxis_enable_agent` with `agent: "page"`. Before turning it on, the server shows the data processing agreement in a dialog, since the agents wait on it:

> Before the chat goes on, a dialog shows NxisAI's data processing agreement: please read it, then choose who accepts. Then it asks you to confirm turning the chat on.

They accept for the organization, then confirm; it returns `state: "live"`. The choice is not repeated in the conversation. `nxis_agents_catalog` with `by_fit: true` puts a support agent first; they want it, labeled "Help" in their words, with one example question. `nxis_agents_catalog` with `agent: "support"` lists `label` (required, up to 100 characters) and `examples`, and no connection prerequisite, so `nxis_enable_agent` with `agent: "support"`, `settings: {"label": "Help", "examples": ["Do you ship to Canada?"]}`, confirmed in its dialog.

For the chat's look they take the offered values (the site's name, `public/logo-mark.svg`, the `--color-action` token and the `/privacy/` route): `nxis_agents_brand` with `name: "Example Outfitters"`, `logo: "https://example.com/logo-mark.svg"`, `accent: "#C73A17"`, `privacy_url: "https://example.com/privacy/"`, confirmed in its dialog.

**Step 13.** They want the app. `nxis_list_in_app` `preview: true`: the title is "example.com", so `nxis_set_site_name` with "Example Outfitters", then `nxis_list_in_app`, confirmed in its dialog.

**Step 14.** `nxis_agents_status`: `page` and `support` are `live` in `agents`, `verified_hosts` is `["https://example.com"]`, no kill switch. The home page shows the chat button.

> Done. example.com is live as an MCP server, with its discovery files and the site tag, and the chat on your pages runs NxisAI's hosted assistant and a Help agent, with nothing else added to the site. If you ever need to stop them, ask me to pause them: it takes seconds. It's listed in the NxisAI app as **Example Outfitters**.

## Composing with other skills

- **nxis-account-setup** covers steps 1 to 3 on their own, and installs the MCP connection. Use it when the user only wants an account
- **mcp-discovery-publishing** is the natural next step: once deployed, it confirms an agent can find the server through the discovery files, and checks the NxisAI app listing
- **site-tag-installation** is the server-side alternative to step 11 (`NxisClient`), and the place for token rotation later
- **on-page-agent** hosts the agent harness on the site itself, with its own model and relay. A site uses it or the hosted page agent, never both
- **support-agent**, **quote-agent** and **booking-agent** build self-hosted agents behind that harness
- **hosted-agents** turns on, configures, pauses and checks the agents NxisAI hosts, at step 12 and afterwards
- **action-binding** builds the receiver behind a connection from step 9, from its [host references](../action-binding/references/hosts/) for Next.js, Netlify, Vercel, Cloudflare Workers, Express and Fastify: where the signing secret is stored, and the handler that checks signatures, answers checks and commits once
- **typed-retrieval** is what the site's MCP server is for, once it is live
- The **lead funnel** skills (Quote, Reservation, Application) execute any actions step 9 bound
- **The host's own skills**, when installed, own deploys, environment variables and static-file configuration

This skill owns **first-time setup**. It does not maintain a site afterwards: re-crawling, regenerating structured data, rotating the site tag and changing agent policy are separate jobs, and the hosted agents afterwards are **hosted-agents**.

## Tool reference

The MCP tools, on the `nxis-onboarding` server (either MCP transport). The CLI commands for each are in the step table above.

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_list_orgs` | The user's organizations, each with `current`, and `current_org_id`. The first call of a run; signed out, it shows the sign-in (local server only) | none |
| `nxis_use_org` | Make one the current organization, by id or exact name; the next call acts on it. `org_pinned` on a server started with `--org` (local server only) | `org` |
| `nxis_create_org` | Create the organization and make it current, after the user's yes in a dialog; reuses an unnamed one (`reused: true`) (local server only) | `name`; `website`, `industry` |
| `nxis_choose_plan` | The user picks a plan in a dialog; a paid one waits for its payment. Changes nothing when there is one (local server only) | none |
| `nxis_list_sites` | The organization's sites, with their verification and MCP state | none |
| `nxis_create_site` | Create the site | `url` |
| `nxis_verify_site` | `token` returns the META tag, `check` verifies it | `mode`, `site` |
| `nxis_crawl_sitemap` | `submit` queues a crawl, `status` reports its state | `mode`, `url`, `site` |
| `nxis_bulk_autofill` | `plan` counts, `submit` starts (billed), `status` reports; `existing`, `media_type`, `pattern` | `mode`; pass `existing` every time |
| `nxis_publish_entities` | Publish generated drafts | none; `dry_run` to count first |
| `nxis_list_types` / `nxis_query` | Sample the published records | none / `filter.schema_type` |
| `nxis_mcp_settings` | Read the site's MCP settings before changing them | `site` |
| `nxis_enable_public_mcp` | Turn on the site's public MCP server | `site` |
| `nxis_bind_mcp_action` | Route a site action's submissions to its own page | `site` |
| `nxis_list_connections` | The site's connections, and what uses each (local server only) | `site` |
| `nxis_create_connection` | A named address on the user's servers; with `write_env`, writes its signing secret into a gitignored env file instead of returning it (local server only) | `site`, `name`, `url`; `write_env`, `env_name` |
| `nxis_rotate_connection_secret` | A new signing secret, the same way; only when the user asks (local server only) | `site`, `connection`; `write_env` |
| `nxis_delete_connection` | Delete a connection nothing uses, such as one made for a tunnel (local server only) | `site`, `connection` |
| `nxis_test_connection` | Send the receiver one signed check call and report its `verdict` (local server only) | `site`, `connection` |
| `nxis_bind_connection` | Send a route's requests through a connection (local server only) | `site`, `action`, `connection` |
| `nxis_aio_files` | The discovery files for the site | `site` |
| `nxis_site_tag` | `status` reads the site tag token, `issue` signs one | `mode`, `site` |
| `nxis_set_site_name` | The name the site is listed under | `site`, `display_name` |
| `nxis_list_in_app` | List the site in the NxisAI app; `preview: true` changes nothing | `site` |
| `nxis_accept_dpa` | The user accepts the data processing agreement in a dialog, for the organization or the site's legal entity. Changes nothing when it is accepted (local server only) | `site` |
| `nxis_agents_status` | Each hosted agent's `state` and why, the kill switches, `live`, `go_live_blocked_by`, `verified_hosts` (local server only) | `site` |
| `nxis_agents_catalog` | Without `agent`: the catalog, with fit and what is unmet (`by_fit`, `job`, `industry`, `readiness`, `added`, `query`). With `agent`: its settings, prerequisites, `unmet` and `enable_with` (local server only) | `site`; `agent` |
| `nxis_enable_agent` | Turn an agent on with its `settings` by name; asks the connection, then the agreement, then a yes, in dialogs. A refusal carries `next` (local server only) | `site`, `agent`; `settings`, `connection` |
| `nxis_configure_agent` | Change settings, or `clear` them by name, without turning it on or off; asks a yes while it is on (local server only) | `site`, `agent`; `settings`, `clear` |
| `nxis_disable_agent` | Turn an agent off, keeping its settings, after a yes (local server only) | `site`, `agent` |
| `nxis_pause_agents` | Pause one `agent`, or every agent with none; `tools`, `reason`. Never asks (local server only) | `site`; `agent`, `tools`, `reason` |
| `nxis_resume_agents` | Lift one agent's pause, or the site-wide one with no `agent`, after a yes (local server only) | `site`; `agent` |
| `nxis_agents_brand` | The on-page chat's `name`, `logo`, `accent`, `privacy_url`, or `clear` parts, after a yes (local server only) | `site` |

On the local server, sign-in needs no tool: a call made while signed out shows the sign-in link and code itself. Every step of the setup has a tool there. Outside the setup, the guardrails policy and stored transcripts (`nxis agents policy`, `nxis agents transcripts`) and buying credits ahead of a billed run (`nxis credits buy`) run through `nxis` in the shell, when the user asks. On the remote server the organization, setup, connection and hosted-agent tools are missing, so those steps use the CLI there. A permission error on every MCP call means the connection belongs to a different organization than the one being set up.
