---
name: agentic-site-onboarding
display_name: Site Onboarding
icon: 🚀
source: NXISAI
description: >
  Onboard a site onto NxisAI from its own project, through the nxis CLI or MCP:
  sign in, pick a plan, verify the site, crawl it, publish structured data, turn
  on its MCP server, write discovery files and the site tag, and turn on the
  hosted agents.
license: Apache-2.0
compatibility: >
  Any host. Runs inside the project that builds the site; the user deploys.
  Needs the nxis CLI (nxis, or npx -y @nxisai/cli) with the nxis agents
  commands. MCP transports use the nxis-onboarding server.
metadata:
  author: nxisai
  version: 2.2
allowed_tools:
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
  - nxis_aio_files
  - nxis_site_tag
  - nxis_set_site_name
  - nxis_list_in_app
enabled: true
---

Onboard a site onto NxisAI from inside the developer's own project: sign in, choose a plan, create and verify the site, ingest its pages, generate structured data, expose it as an MCP server, put the site tag on its pages, and turn on the hosted agents that the tag brings with it.

You are running where the site's source lives. That is the reason this can be done at all: verification and the site tag are file changes and a deploy, not something a browser wizard can do for someone.

## When this skill applies

Use this skill when **all** of the following are true:

- The user wants a site set up on NxisAI, and can sign in with Google in a browser
- You are running in the project that builds the site, and can run `nxis` in a shell (or `npx -y @nxisai/cli`, which runs the same commands)
- The site is one the user can deploy

Do not use this skill for:

- A site already onboarded, or changing an existing site's settings. This is first-time setup
- Sites you cannot deploy. Verification will never pass, and every step after it does nothing
- A site that renders on a server and wants its JSON-LD in the HTML response (`NxisClient`) instead of the CDN tag. That path is **site-tag-installation**
- Hosting the agent harness on the site yourself, with your own model and relay. That is **on-page-agent**, and it replaces the hosted page agent in step 12 rather than adding to it

## Step 0 — Choose the transport, once

Every step below can run through one of three transports. They reach the same NxisAI services and the same site, so a run can switch between them, but ask once, early, and stay with the answer.

| Transport | Set up with | Credential | Pick it when |
|---|---|---|---|
| **CLI** (default, recommended) | Nothing more: `nxis … --json` in the shell | The CLI's own sign-in, in the OS keychain | Almost always. Every step has a command |
| **MCP, local** (stdio) | `nxis mcp install`, then reload MCP servers (`/mcp` in Claude Code) | None in the agent's config: it runs `nxis mcp serve`, which uses the CLI's sign-in | The user wants tool calls, with the server asking them itself before anything billed or public |
| **MCP, remote** | `nxis mcp install --remote`, then reload | An MCP key, written into the agent's config | The agent cannot start a local process |

Put it to the user as a numbered choice with CLI first and marked recommended. If `nxis-onboarding` tools already work in this session, offer to keep using that connection as a fourth option, and do not reinstall it: `nxis mcp install` stops with `server_exists`, and `--force` would replace a server that may point at another organization.

Whatever the transport:

- **Sign-in, the organization, the plan, and the hosted agents and their branding (steps 1 to 3 and 12) always run through the CLI.** No MCP tool covers them. The remote transport is installed with the CLI, so it is there too
- **Never put a key in the chat or the project.** `nxis mcp install` writes it into the agent's config and shows only a preview. Do not run `--print` unless the user asks to configure a client by hand. On a shared machine, prefer the local server, which holds no key
- **Exit codes and reasons are the same contract.** The CLI exits with one of four codes and prints one JSON object; an MCP tool failure comes back with `isError: true` and the same object (`ok`, `reason`, `error`)

| Exit | Means | Do |
|---|---|---|
| `0` | Done | Continue |
| `2` | Needs the user: a sign-in, a payment, a deploy or a choice | Relay the message and the `reason`. **Never retry the command on its own** |
| `3` | Not authorized | `nxis login`, then run the command again |
| `1` | Failed | Report the error as given |

**The local MCP server asks the user before a risky call.** An autofill submit, a real publish, turning the MCP server public, routing actions to a webhook and listing in the NxisAI app each raise a question through the agent's client (MCP elicitation) before anything is sent. That is a second check, not a replacement for asking in the conversation. A refusal comes back as `declined_by_user` or `cancelled_by_user`: stop and ask, do not call again. A client that cannot ask returns `confirmation_unavailable`, with what the call would have done (`would_do`) and the equivalent `terminal_command`: on the user's yes, run that command in the shell. Never start the server with `--allow-unconfirmed` on your own. A call made while the CLI is signed out returns `signed_out`; run `nxis login`, and the next call works without a restart.

**Pointing at another environment.** `--api <url>` or the `NXIS_API` variable points the CLI, and a local MCP server installed with it, at another NxisAI environment, for testing. A sign-in belongs to its environment, so the CLI asks for a new one there (`environment_mismatch`, exit 3). `--api production` goes back. The read-back checks (step 8's record check, step 14's types) need that environment's own site MCP endpoint, since `nxis types` and `nxis query` may still read production's: if `nxis types` fails with `site_mcp_not_public` right after `mcp public on`, that is the cause, not the setting.

## The commands, step by step

Use the CLI column on the CLI transport and the MCP column on either MCP transport. Pass `--json` on every CLI command. Each command acts on the current organization and site (`--org`, `--site <id|domain>`, or the ones saved by `orgs use` and `sites create` or `sites use`); MCP tools take the site id as `site`.

| Step | CLI | MCP tool |
|---|---|---|
| 1. Sign in | `nxis status`, `nxis login` | CLI only |
| 2. Organization | `nxis orgs list`, `nxis orgs use <id>`, `nxis orgs create --name … --website …` | CLI only |
| 3. Plan | `nxis plans`, `nxis subscribe <tier>`, `nxis credits packs`, `nxis credits buy <sku>` | CLI only |
| 4. Site | `nxis sites list`, `nxis sites use <id\|domain>`, `nxis sites create <url> [--name …]` | `nxis_list_sites`, `nxis_create_site` |
| 5. Verification tag | `nxis sites verify --token` | `nxis_verify_site` `mode: token` |
| 6. Verify | `nxis sites verify --check` | `nxis_verify_site` `mode: check` |
| 7. Crawl | `nxis crawl submit [<sitemap-url>] --wait`, `nxis crawl status --wait` | `nxis_crawl_sitemap` `mode: submit`, then `status` |
| 8. Structured data | `nxis autofill plan`, `nxis autofill submit --yes --wait`, `nxis autofill status`, `nxis publish` (counts, then stops), `nxis publish --yes`, `nxis types`, `nxis query <type>` | `nxis_bulk_autofill` `plan` / `submit` / `status`, `nxis_publish_entities`, `nxis_list_types`, `nxis_query` |
| 9. MCP server | `nxis mcp settings`, `nxis mcp public on`, `nxis actions bind …` | `nxis_mcp_settings`, `nxis_enable_public_mcp`, `nxis_bind_mcp_action` |
| 10. Discovery files | `nxis discovery files`, then `--write [--out <dir>]` | `nxis_aio_files`, then write the files yourself |
| 11. Site tag | `nxis sites tag status`, `nxis sites tag issue --domain … --webmcp-mode browser` | `nxis_site_tag` `mode: status`, then `issue` |
| 12. Hosted agents | `nxis agents enable page`, `nxis agents brand --name … --logo … --accent … --privacy-url …`, `nxis agents enable support --label …`, `nxis agents status`, `pause`, `resume`, `policy show` | CLI only |
| 13. NxisAI app | `nxis sites list-in-app --preview`, `nxis sites name <name>`, `nxis sites list-in-app` | `nxis_list_in_app` (`preview: true` first), `nxis_set_site_name` |
| 14. Final check | `nxis agents status`, `nxis types` | `nxis_list_types` for the records; `nxis agents status` is CLI only |

## The host the site deploys to

No step names a host. Where one matters (what counts as production, which variables hold a generated URL, where static files go), find the answer in the project:

| Question | Netlify | Vercel | Cloudflare |
|---|---|---|---|
| How do I know it is this host? | `netlify.toml`, `.netlify/` | `vercel.json`, `.vercel/` | `wrangler.toml`, `wrangler.jsonc` |
| What counts as production? | `CONTEXT=production` | `VERCEL_ENV=production` | The production branch; `CF_PAGES_BRANCH` on Pages |
| Which variables hold a generated host, never the canonical one? | `URL`, `DEPLOY_PRIME_URL` | `VERCEL_URL` | `CF_PAGES_URL` |
| Where do static files go? | The publish directory in `netlify.toml` | The framework's `public/` | The build output or assets directory |

For any other host, ask the user those four questions rather than guessing.

## The pattern

Work in order. Steps 7 onward silently do nothing until step 6 has passed, and the run stops twice for the user to deploy (steps 5 and 11).

### Step 1 — Sign in

Run `nxis status --json` first. It never fails for "not signed in"; it reports `signed_in`, the organizations, `active_org`, `active_site`, the `subscription` and the credits. Skip every step it shows is done.

If not signed in, run `nxis login`. It prints a URL and a short code, then waits. **Relay both exactly as printed**, and tell the user to check that the code on the page matches. The URL works from any device, a phone included, when this machine has no browser. Never ask for a password, a Google code or a one-time code in the conversation; if the user offers one, tell them not to.

### Step 2 — The organization

If `status` lists one organization, use it. With several, ask which, then `nxis orgs use <id>`. With none, ask what it should be called (the site's own name is usually right; the project directory usually is not) and run `nxis orgs create --name "…" --website "https://…"`. An empty organization left from a browser signup is reused (`reused: true`) rather than duplicated.

On the local MCP server, the organization is read from the CLI's saved state on each call, so `orgs use` takes effect without reinstalling. On the remote one it is the key's organization: a permission error on every call means the key belongs to another one.

### Step 3 — Choose a plan

Skip this if `status` shows a live `subscription`. Otherwise run `nxis plans --json`: each plan has `tier`, `name`, `price`, `interval`, `credits` and `lifetime` (free plans grant their credits once).

Put the plans to the user as numbered choices, with the price, the interval and the credit grant in the message that asks, and add **Cancel**. Offer, in this order: the free plan; the free plan plus a credit top-up; a paid plan. Wait for an explicit pick.

- Never choose a paid plan for the user. "Set me up", "do whatever you need" and silence are not consent to be charged
- Free: `nxis subscribe free`
- Paid: `nxis subscribe <tier>` prints the amount, opens the payment page and waits. Payment is the user's: card details go to the payment page and never to you, the CLI or this conversation. Say what it is waiting for, and do not claim it went through until it exits `0`. With no browser here, `--no-open` prints the link to relay
- A top-up needs a plan first: `nxis subscribe free`, then `nxis credits packs`, then `nxis credits buy <sku>`. `no_active_plan` means the order was wrong; subscribe first

| Exit 2 `reason` | Do |
|---|---|
| `choose_plan` | Put the options to the user, as above. `nxis signup` returns them in `options` |
| `payment_pending` | **Do not run `subscribe` again**: a second run opens a second checkout and can charge twice. Wait for the user, then `nxis status` |
| `no_active_plan` | `nxis subscribe free` before the top-up |
| `sign_in_required` | `nxis login` |

### Step 4 — Create the site, or use one that exists

Run `nxis sites list` (`nxis_list_sites`). If the site is already there, `nxis sites use <id|domain>` and carry on from the first step it has not done.

Otherwise **ask the user for the URL** rather than inferring it from the repository: a monorepo, a staging domain or a subdomain are easy to guess wrong, and the host is fixed at creation. `www.example.com` and `example.com` are different sites; create it on the host production serves. Then `nxis sites create <url> [--name "…"]` (`nxis_create_site` with `url`; name it later with `nxis_set_site_name`). The CLI saves it as the current site. Keep the site id: every MCP call after this takes it.

### Step 5 — Write the verification tag in, then stop for a deploy

`nxis sites verify --token` (`nxis_verify_site`, `mode: token`) returns the META tag: `tag`, with its `name` and `content`. Add it to the site's HTML head, where the project already keeps meta tags (a layout, a template, a head component), rather than adding a new mechanism.

Then **stop and tell the user to deploy to production**, and say why: the verifier fetches the site's own URL, so a deploy preview or branch deploy on a generated host never verifies, however correct the tag in it is. How to reach production is the host's business (a merge to the production branch, a promote, a production deploy command); if the project has skills for its host, send the user there.

Write only the verification tag now. The site tag comes in step 11, once the site is verified and has data to serve.

### Step 6 — Verify, once it is deployed

`nxis sites verify --check` (`nxis_verify_site`, `mode: check`).

`site_not_verified` (exit 2, with `verifier_reason`) almost always means the deploy has not landed yet. Say that, and check again when the user says it is live, or 20 to 30 seconds apart, never in a tight loop. If it keeps failing after a production deploy, check first whether what was deployed was a preview. `site_unreachable` means the site cannot be fetched at all; waiting will not help, so the site has to be deployed at its address first.

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

**Plan first.** `nxis autofill plan --existing import_and_complete` (`nxis_bulk_autofill`, `mode: plan`, `existing: import_and_complete`). It returns `resource_count`, a `by_media` breakdown, `credits_remaining` and the `existing` mode. On MCP, pass `existing` on every call, `plan` and `submit` alike, since the tool's own default is `generate`.

| `existing` | What happens | Cost |
|---|---|---|
| `import_and_complete` (**the default to offer**) | Each page's own JSON-LD is kept; AI generates only what it lacks, such as actions from its forms | Varies |
| `import` | Only the JSON-LD the pages publish, no AI; a page with none gets nothing | Fixed per page: `import_cost_per_resource_milli` |
| `generate` | AI writes everything; the site's own JSON-LD is ignored | Varies |

Look at the project first: if its templates emit `<script type="application/ld+json">`, say so and which kinds of record. When that JSON-LD already publishes the site's actions (a `potentialAction` its forms serve), recommend **Import only**: completing would generate a second action from the same form, at model cost.

**Put the decision to the user as enumerated choices, never a question in prose**, with the count and the balance:

1. **Import and complete** (recommended): keep what the site publishes, generate what is missing
2. **Import only**: no AI, at the fixed price per page
3. **Generate everything**: AI writes all of it
4. **Restrict the scope**: one media type (`--media-type HTML|IMAGE|VIDEO|AUDIO`, `media_type`), or a path (`--pattern /products/*`, `pattern`). Combines with any of the above
5. **Cancel**

Use the harness's structured-choice affordance if it has one; otherwise a short numbered list, then stop. Consent asked in prose reads as answered at the first "yes", and the narrower options are never seen. If they pick another mode or a narrower scope, plan again with it and show the new count, so the number they approve is the number that runs. Do not estimate a total cost; the plan leaves it out on purpose. For `import` only, give the fixed price and the count.

**Say when the balance may not cover it.** When the count is large next to `credits_remaining` (a free plan's one-time grant against a full site, say), tell the user the batch may stop partway, and offer restricting the scope with a path pattern, or a top-up (`nxis credits packs`), before the submit.

**Submit once, on an explicit yes, with exactly what was approved.**

- **CLI:** `nxis autofill submit --existing … [--media-type …] [--pattern …] --yes --wait`. `--yes` says the user has seen and approved the plan; never pass it otherwise. Without it, in a shell with no terminal, it exits 2 `confirmation_required` with the plan
- **MCP:** `nxis_bulk_autofill`, `mode: submit`, with the same `existing` and scope, then poll `mode: status` with the `batch_id` every 20 to 30 seconds

**Never submit twice.** It is a billed write. On a timeout or a dropped connection, follow the batch instead:

| What you see | Do |
|---|---|
| `submit_unconfirmed` (CLI, exit 2) | The submit may have started a batch. Follow `batch_id` if given (`nxis autofill status --wait`), or look with `nxis autofill status --recent` |
| `started: false` | A batch was already running; nothing new was charged. Follow the one it names |
| `nothing_planned`, `credits_exhausted` | Nothing was submitted. Report it; for credits, offer `nxis credits packs` |

**A partial batch is not a failed run.** `PAUSED` (`autofill_paused` on the CLI, exit 2) means credits ran out partway, and it will not advance on its own; do not submit again to resume it. `COMPLETE` with many `failed` can mean the same: the credits ran out (the balance may end slightly negative), or those pages hit a quota. `nxis status` shows the balance. Either way the completed pages are drafts: publish them and finish the run, then say how many of how many are live, which limit stopped the rest and what would lift it. Stop early only if **zero** pages completed.

**Publish what was generated.** Autofill produces drafts, and a draft serves nothing. Publishing needs no consent gate of its own, since the user agreed to generate this data, but it changes what the site serves publicly, so say that it happened and how many.

- **CLI:** the first `nxis publish` for an organization creates an MCP access key for it, kept in the OS keychain. Say so and ask before that first publish. `nxis publish --json` without `--yes` counts what would go live and exits 2 `confirmation_required` with `published_count`; then `nxis publish --yes --json`. Do not count with `--dry-run`: before the key exists, the global `--dry-run` only prints the key request it would send
- **MCP:** `nxis_publish_entities` with `dry_run: true` to count, then without

Afterwards report `published_count`. `skipped_disabled_count` being most of the batch, or equal to it, is normal. A published count of zero after a successful batch means it produced nothing; check before reporting success.

**Check the records carry what agents filter on.** Once step 9 turns the MCP server public, `nxis types` and `nxis query <type> --limit 10` on the two or three main types (`nxis_list_types`, `nxis_query`) show them. Report, without changing anything: businesses typed only `LocalBusiness` or `Organization` where a subtype fits (`Electrician`, `Restaurant`), and business records without `address.addressLocality`. If either shows up, say how many records and offer to regenerate them; that is a second billed autofill and needs its own yes.

### Step 9 — Turn on the site's MCP server

Read first: `nxis mcp settings` (`nxis_mcp_settings`). On a rerun, or for a site someone configured in the dashboard, report what is on and change only what differs from what the user asked for. Never turn off something you did not turn on.

Then `nxis mcp public on` (`nxis_enable_public_mcp`). This makes the published records queryable without a key, and prints the endpoint. It is the point of everything above, and what the Support Agent in step 12 answers from.

If the site has actions worth routing (a booking form, a quote request), `nxis actions bind <action|default> --self-page | --webhook <url> | --gateway` (`nxis_bind_mcp_action`). Skip it on most first setups. A new webhook binding prints its signing secret once: tell the user to store it in the receiving application's configuration, and do not repeat it in summaries.

### Step 10 — Write the discovery files

`nxis discovery files` (`nxis_aio_files`) returns `llms.txt`, `agents.md`, `.well-known/ai-catalog.json` and `.well-known/mcp/catalog.json`, with their paths. If there is no MCP endpoint in them, step 9 did not take; go back rather than publishing files that advertise a server that refuses every agent.

**Read what they say before writing them.** Every host, name and description must name the site from step 4. One that names the organization or another host is a defect: report it, and do not write it. Agents take these files as the site's own description.

**Check the project's own checks first.** Some projects lint or scan `public/` or static files in a build step or script and fail on strings these files carry (`schema.org`, the MCP host). If one would, tell the user which rule the files break and what change the project needs; do not edit the check yourself.

**Check the project serves `.well-known/`.** Some frameworks drop dot-directories from their output. If it needs configuration, make that change too, or tell the user.

**Write them into the site's public root, merging, never overwriting.**

- **CLI:** `nxis discovery files --write` merges into `public/` or `static/` when exactly one exists, or `--out <dir>` (the static directory from the host table). It keeps every existing catalog entry, title and section, adds only what is missing, refuses an invalid catalog, and prints a diff. Show the user the diff
- **MCP:** write the four files yourself, at the paths the response gives. Where a file exists: in `llms.txt`, keep their title, summary and sections exactly, and add the `## Agent access` section or only its missing links; in `agents.md`, add the NxisAI section if absent; in both catalogs, keep every entry, and update in place an entry that already points at this MCP endpoint rather than appending a duplicate. `ai-catalog.json` must stay valid JSON with an entry carrying a `url`. Show the diff for every file that existed

These go live with the deploy at the end of step 11.

### Step 11 — Write the site tag in, then stop for the second deploy

The site tag (`nxis.js`) puts the site's JSON-LD on every page, registers its actions as WebMCP tools, and, once step 12 turns them on, brings the hosted agents. It is issued only for a verified site.

1. **Decide the hosts.** The production host, plus `localhost` if the site is ever run locally (one entry covers every port). Never `*`. Deploy previews do not fit: a preview's host names one deploy, so say that previews show the site without the tag
2. **Read before issuing.** `nxis sites tag status` (`nxis_site_tag`, `mode: status`). If the token's claims already say `webmcp_mode: browser` and list those hosts, use it
3. **Otherwise issue.** `nxis sites tag issue --domain example.com --domain localhost --webmcp-mode browser` (`nxis_site_tag`, `mode: issue`, `domains`, `webmcp_mode: browser`). The site's own host is always added. `site_not_verified` (exit 2) sends you back to step 6. Re-issuing never breaks a live tag; the old token works until it expires
4. **Check the claims before writing.** `claims.webmcp_mode` is `browser` (with `none`, no tools register), `claims.site_id` is this site, `claims.domains` has every host from 1, and `claims.expires_at` is in the future. If any is wrong, do not write it; reissue
5. **Look for a check that scans the head** (forbidden strings such as the MCP host or the script name, in a lint or build step). If one would fail on the tag, tell the user which rule and what change it needs, rather than editing the check
6. **Write `script_tag` into the head**, beside the verification META, exactly as returned. Put it behind a build-time switch that leaves it out, so the site can be compared with and without it. The token is public and domain-scoped, made to sit in page HTML, so it may be committed: say so, and say that the onboarding credentials are secrets and never go in the project. Add a comment with the expiry, the mode and the hosts

Then **stop and tell the user to deploy to production**: the discovery files from step 10 and the tag go live together. Once it is live, a page's source has the tag, a `<script type="application/ld+json">` has been injected into the head, and `await document.modelContext.getTools()` returns the site's actions. If that list is empty on a site with forms, look at the token's mode first and its hosts second.

### Step 12 — Turn on the hosted agents

With the hosted agents on, the site tag draws the chat button and loads the agent harness from the NxisAI CDN by itself. **The site adds nothing else**: no package, no script, no model key, no relay. Changes reach the site within seconds. These commands run through the CLI on every transport.

**First, check the project does not already host its own agent.** If it depends on `@nxisai/agent-harness`, mounts it in a layout or script, or `nxis mcp settings` shows `on_page_agent` on, the site runs a self-hosted agent (the **on-page-agent** skill). Do not enable the hosted page agent there: the site would show two agents. Say so, and let the user choose one. Likewise, if the project runs its own support agent (the **support-agent** skill), ask before enabling the hosted one.

Ask before enabling: it puts a chat on every page of the live site. Then:

- **The page agent:** `nxis agents enable page`. `--model <id>` picks a model; leave it out for the default
- **The chat's branding:** without it the chat shows the default look. Ask the user for the name visitors see, a logo, an accent color and the privacy page, offering what the project has: the site's name, a square logo or mark in its static files, the primary action color from its CSS tokens, and its privacy route. The logo and privacy page are full `https://` URLs on the production host, so the logo must be deployed. Then `nxis agents brand --name "…" --logo https://… --accent "#rrggbb" --privacy-url https://…`, with only the parts they choose; `--clear <part>` resets one. The name is at most 60 characters and the accent `#rgb` or `#rrggbb`
- **The Support Agent, if the user wants it:** `nxis agents enable support --label "Help"`, with `--description` and up to 10 `--example "…"` questions if they have them. It answers from the site's MCP server, so it needs step 9; without one it stays off and `status` says so. The label is what visitors read, so ask for it (`missing_label` otherwise)
- **Read it back:** `nxis agents status --json` returns `page` and `support` (each with `enabled`, `model`, `kill_switch`; `page` also has `branding` and `privacy_url`), the site-wide `kill_switch`, `policy_version`, `mcp_server`, `verified_hosts`, and how transcripts are kept. A change that matched the settings already reports `changed: false`. `version_conflict` means someone else changed them at the same moment: run the command again

Tell the user, briefly:

- **The kill switch.** `nxis agents pause` refuses every turn on every hosted agent; `pause page` or `pause support` names one; `--tools` refuses only turns that would use a tool that changes something; `--reason "…"` is what visitors are told. `nxis agents resume [page|support]` lifts the one it names, or the site-wide one with none. An agent is held to the stricter of its own pause and the site's
- **The policy.** `nxis agents policy show` prints the guardrails policy and its version; `nxis agents policy set <file.json>` replaces it whole. Do not write one unless the user asks for a change
- **Transcripts.** Visitors' conversations are stored, redacted, for 30 days unless changed; `nxis agents transcripts settings` changes that or stores none

### Step 13 — Offer the NxisAI app

The NxisAI app lets people find the site from Claude and ChatGPT, browse its records and act on them. Being listed is the user's choice: **ask first**, and skip this step on a no.

1. **Preview it.** `nxis sites list-in-app --preview` (`nxis_list_in_app`, `preview: true`) changes nothing and returns `as_listed`: the title, categories, places and capabilities the app would show, with `next` notes. Show the user that
2. **Name it.** If the title is a domain, ask what people call the site and `nxis sites name "…"` (`nxis_set_site_name`)
3. **Who can see it.** With the MCP server public, anyone can browse it in the app. Say so, and change it only if the user asks
4. **List it.** `nxis sites list-in-app` (`nxis_list_in_app`). Act on each `next` note: *not actionable from the app* means its actions run on its own pages, so offer `nxis actions bind`; *no places* or *no specific type* points back to step 8's record check; *discovery files don't link the server* means step 11's deploy has not landed

It appears in the app within a few minutes. **mcp-discovery-publishing** checks it there.

### Step 14 — The final check

On the production site, once the second deploy is live:

- `nxis agents status --json` shows `page.enabled: true`, no `kill_switch` set, and the site's own origin (such as `https://example.com`) in `verified_hosts`. With the Support Agent on, `support.enabled: true` and `mcp_server` is not `null`
- Loading a production page shows the chat button, with nothing added to the site but the tag
- `nxis types` (`nxis_list_types`) lists the published types with counts

If the button is missing: the tag is not in the deployed page, the page is on a host the token does not list, `page.enabled` is `false`, a kill switch is on, or the origin is not in `verified_hosts`. Check in that order. Then give the user the site's MCP endpoint and what they can ask it, and offer **mcp-discovery-publishing** to confirm an agent can find the server through the discovery files.

## Best practices

- Ask the transport once, with CLI first, and keep to it
- Run `nxis status` first and skip what is done. A user coming back may need only the last few steps
- Ask for the site URL. Do not infer it from the repository
- Work out the host from the project before step 5, so you can say how to reach production rather than just "deploy"
- Say clearly when you are waiting on the user, and for what: a sign-in, a payment, or one of the two deploys
- Check the site names its own host before the crawl. It is the last point where fixing it costs nothing
- Put the plan choice and the autofill scope options in front of the user with the numbers, not after a yes to them
- Read settings (`mcp settings`, `sites tag status`, `agents status`) before changing them, and report what was already in place
- Look for a self-hosted agent harness before enabling the hosted page agent

## Anti-patterns

- Choosing a paid plan, or reading "set me up" as consent to be charged
- Running `subscribe` again after `payment_pending`. It opens a second checkout
- Retrying any command that exited `2`. It is waiting on a person, not failing
- Continuing past step 6 before verification passes. The steps after it look like they worked
- Telling the user to "deploy" when the host's default deploy is a preview. It will never verify
- Crawling a site whose sitemap or source names another host
- Asking for autofill consent in prose, passing `--yes` without an explicit yes to that plan, or submitting twice
- Estimating credit cost. The count and the balance are the honest figures
- Finishing without publishing. Drafts serve nothing
- Writing a discovery file that names anything other than the site, or overwriting one that exists
- Writing a site tag token without checking its mode, hosts and expiry
- Enabling the hosted page agent on a site that already hosts `@nxisai/agent-harness`. Visitors get two agents
- Adding the agent harness, a script or a model key to the site for the hosted agents. The tag brings them
- Pasting a key into the chat or the project, or starting the MCP server with `--allow-unconfirmed` on your own
- Listing the site in the NxisAI app without asking
- Committing or deploying on the user's behalf unless they asked

## Worked example

**User:** "Set up my site on NxisAI."

**Step 0.** Asked how to connect: 1. CLI (recommended), 2. local MCP server, 3. remote MCP. They pick the CLI.

**Steps 1 to 3.** `nxis status --json`: not signed in. `nxis login` prints a URL and `QRTL-WMXK`; relayed. Signed in, no organization: they call it "Example Outfitters", `nxis orgs create --name "Example Outfitters" --website "https://example.com"`. `nxis plans --json` lists Free (no card, credits once) and Starter (monthly). They pick Free: `nxis subscribe free`.

**Step 4.** `nxis sites list --json` is empty. `nxis sites create https://example.com --json`. The project has a `netlify.toml`, so production is the production branch and previews run on `*.netlify.app`.

**Step 5.** `nxis sites verify --token --json`; the META tag goes into `src/layouts/base.html`.

> I've added the verification tag to src/layouts/base.html. Merge it to your production branch and tell me when it's live on example.com. A deploy preview won't verify, because the check fetches example.com itself.

**Step 6.** `nxis sites verify --check --json` exits `0`.

**Step 7.** `nxis crawl submit --wait --json` exits `2` with `sitemap_off_host`: every page is on `example-shop.netlify.app`, because `src/lib/site.ts` reads Netlify's `URL`. Changed to a constant overridable by a variable; after their deploy, the crawl runs to `COMPLETE`.

**Step 8.** The product templates emit `Product` JSON-LD. `nxis autofill plan --json`: 340 resources (290 HTML, 50 IMAGE), 7,500 credits.

> Ready to add structured data for **340 resources**. You have **7,500 credits**. I can't tell you the exact cost in advance; it varies per resource.
>
> 1. **Import and complete** (recommended): keep your Product data, generate the rest
> 2. **Import only**: just your own JSON-LD, at a fixed price per page
> 3. **Generate everything**: AI writes all of it
> 4. **Restrict the scope**: HTML only (290), images only (50), or a path such as /products/*
> 5. **Cancel**

They pick 1, HTML only. `nxis autofill plan --media-type HTML --json`: 290. They confirm. `nxis autofill submit --existing import_and_complete --media-type HTML --yes --wait --json` runs to `COMPLETE`. Before the first publish: "This creates an access key for your organization, kept in your keychain. OK?" Yes. `nxis publish --json` exits `2` `confirmation_required` with `published_count: 290`; `nxis publish --yes --json` publishes 290.

**Steps 9 and 10.** `nxis mcp settings --json`: nothing on. `nxis mcp public on --json`. `nxis types` shows `Store` and `Product`, and the sampled stores all have a locality. `nxis discovery files --json` names example.com throughout; `nxis discovery files --write --json` merges into `public/`, adding `## Agent access` to their existing `llms.txt`. The diff is shown.

**Step 11.** `nxis sites tag status --json`: no tag yet. `nxis sites tag issue --domain example.com --domain localhost --webmcp-mode browser --json`; the claims check out, expiring in a year. `script_tag` goes into `src/layouts/base.html` behind `NXIS_TAG_ENABLED`, with a comment.

> Deploy once more: this puts the site tag and the discovery files live together. The token in the tag is public by design and fine to commit.

**Step 12.** No `@nxisai/agent-harness` in the project. They want the chat and a support agent called "Help": `nxis agents enable page --json`, then `nxis agents enable support --label "Help" --example "Do you ship to Canada?" --json`.

For the chat's look they take the offered values (the site's name, `public/logo-mark.svg`, the `--color-action` token and the `/privacy/` route): `nxis agents brand --name "Example Outfitters" --logo https://example.com/logo-mark.svg --accent "#C73A17" --privacy-url https://example.com/privacy/ --json`.

**Step 13.** They want the app. `nxis sites list-in-app --preview --json`: the title is "example.com", so `nxis sites name "Example Outfitters"`, then `nxis sites list-in-app --json`.

**Step 14.** `nxis agents status --json`: `page.enabled: true`, `support.enabled: true`, `verified_hosts` is `["https://example.com"]`, no kill switch. The home page shows the chat button.

> Done. example.com is live as an MCP server, with its discovery files and the site tag, and the chat on your pages runs NxisAI's hosted assistant and a Help agent, with nothing else added to the site. If you ever need to stop them, `nxis agents pause` does it in seconds. It's listed in the NxisAI app as **Example Outfitters**.

## Composing with other skills

- **nxis-account-setup** covers steps 1 to 3 on their own, and installs the MCP connection. Use it when the user only wants an account
- **mcp-discovery-publishing** is the natural next step: once deployed, it confirms an agent can find the server through the discovery files, and checks the NxisAI app listing
- **site-tag-installation** is the server-side alternative to step 11 (`NxisClient`), and the place for token rotation later
- **on-page-agent** hosts the agent harness on the site itself, with its own model and relay. A site uses it or the hosted page agent, never both
- **support-agent**, **quote-agent** and **booking-agent** build self-hosted agents behind that harness
- **typed-retrieval** is what the site's MCP server is for, once it is live
- The **lead funnel** skills (Quote, Reservation, Application) execute any actions step 9 bound
- **The host's own skills**, when installed, own deploys, environment variables and static-file configuration

This skill owns **first-time setup**. It does not maintain a site afterwards: re-crawling, regenerating structured data, rotating the site tag and changing agent policy are separate jobs.

## Tool reference

The MCP tools, on the `nxis-onboarding` server (either MCP transport). The CLI commands for each are in the step table above.

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_list_sites` | The organization's sites, with their verification and MCP state | none |
| `nxis_create_site` | Create the site | `url` |
| `nxis_verify_site` | `token` returns the META tag, `check` verifies it | `mode`, `site` |
| `nxis_crawl_sitemap` | `submit` queues a crawl, `status` reports its state | `mode`, `url`, `site` |
| `nxis_bulk_autofill` | `plan` counts, `submit` starts (billed), `status` reports; `existing`, `media_type`, `pattern` | `mode`; pass `existing` every time |
| `nxis_publish_entities` | Publish generated drafts | none; `dry_run` to count first |
| `nxis_list_types` / `nxis_query` | Sample the published records | none / `filter.schema_type` |
| `nxis_mcp_settings` | Read the site's MCP settings before changing them | `site` |
| `nxis_enable_public_mcp` | Turn on the site's public MCP server | `site` |
| `nxis_bind_mcp_action` | Route a site action's submissions | `site` |
| `nxis_aio_files` | The discovery files for the site | `site` |
| `nxis_site_tag` | `status` reads the site tag token, `issue` signs one | `mode`, `site` |
| `nxis_set_site_name` | The name the site is listed under | `site`, `display_name` |
| `nxis_list_in_app` | List the site in the NxisAI app; `preview: true` changes nothing | `site` |

Sign-in, organizations, plans, credits, and the hosted agents and their branding have no MCP tool; they run through `nxis` on every transport. A permission error on every MCP call means the connection belongs to a different organization than the one being set up.
