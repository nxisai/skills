---
name: mcp-discovery-publishing
display_name: MCP Discovery Publishing
icon: signal
source: NXISAI
description: >
  Publish a site's AI discovery documents — ai-catalog.json and
  mcp/catalog.json — so agents can find its MCP server unaided, then connect to
  it and confirm it answers, and check how the NxisAI app lists it. Use after
  a site is onboarded, or when an agent cannot discover a site that has an MCP
  server.
license: Apache-2.0
compatibility: >
  Any host that serves static files from the site's own origin.
metadata:
  author: nxisai
  version: 1.1
allowed_tools:
  - nxis_aio_files
  - nxis_list_types
  - nxis_list_in_app
enabled: true
---

Publish the well-known documents that let an agent discover a site's MCP server on its own, then connect to that server and confirm it answers.

A site can have a working MCP server that nothing finds. The endpoint exists, the data is there, and every agent that arrives still has to be told the URL by a human. These two files are how that stops being true.

## When this skill applies

Use this skill when **all** of the following are true:

- The site has an MCP server enabled — normally via **agentic-site-onboarding**
- You can write files to the site's public root and the user can deploy them
- The user wants agents to discover the site without being handed a URL

Do not use this skill for:

- Setting a site up. That is **agentic-site-onboarding**, which turns the server on
- Querying a site's data. That is **typed-retrieval**
- Sites whose MCP server is private. These documents advertise a server publicly, which is the opposite of what a private endpoint is for

## What the two documents do

They overlap on purpose, and which one matters depends on what is looking.

| Document | Path | Purpose |
|---|---|---|
| `mcp/catalog.json` | `/.well-known/mcp/catalog.json` | Advertises the MCP server card. The narrow, MCP-specific answer to "does this site have a server" |
| `ai-catalog.json` | `/.well-known/ai-catalog.json` | A nestable container for any AI artifact — MCP servers today, A2A agents and plugins later. The general answer |

Publish both. They are small, they cost nothing to serve, and an agent that understands only one still finds the site.

An on-page agent built on `@nxisai/agent-harness` reads them in that order of generality: `ai-catalog.json` first, then `mcp/catalog.json` if the first is missing or unusable (from 0.2.4). It follows the first entry that has a `url`. So `ai-catalog.json` has to stay valid JSON with the NxisAI entry in it — a broken one is skipped, not repaired.

## The pattern, in five steps

### Step 1 — Get the documents

Call `nxis_aio_files` with the site. It returns the generated documents and the path each belongs at, matching what the dashboard produces so a site set up by an agent and one set up by hand end up identical.

If the response has no MCP endpoint, the site's server is not enabled. Stop and say so — publishing a catalog that points at nothing is worse than publishing none, because an agent will find it and fail.

**Then read what the documents say about the site.** Every host identifier, display name and description must name this site. One that names the organization, or another host, is a defect in what was generated: report it as one and do not publish it. An agent takes a catalog as the site describing itself, so a wrong name in it becomes a wrong fact everywhere it is read.

### Step 2 — Write them to the site's public root

Both go under `.well-known/` in the directory the host serves static files from — `public/` for most frameworks, or the publish or output directory the host's config names. It is a directory some frameworks and hosts do not serve by default. Check the project's static handling before writing, and say so if it needs configuration rather than writing files that will 404.

If either file already exists, **merge rather than overwrite.** `ai-catalog.json` in particular is designed to hold entries other tools also write:

- Keep every existing entry
- Add the NxisAI entry if no entry already points at this MCP endpoint
- If one does, update that entry in place rather than appending a duplicate

Show the diff for any file that already existed.

### Step 3 — Ask the user to deploy

Nothing is discoverable until the files are live. Say that plainly and stop.

Do not verify before the deploy lands. A fetch against the old deploy will 404 and look like the files are wrong.

### Step 4 — Connect and confirm

Once deployed, fetch `/.well-known/ai-catalog.json` and `/.well-known/mcp/catalog.json` from the site's production origin to confirm both serve JSON — not a 404, and not the framework's `index.html` answering for a path it does not know. Then connect to the MCP endpoint they advertise and call `nxis_list_types`.

That last call is the real check. The catalog can be perfectly formed and still point at a server that answers nothing — an unverified site, or one whose data was never published. A type list with counts is proof the whole chain works.

Report what the site actually exposes, not that the files were written.

### Step 5 — Check it in the NxisAI app, if it is listed there

Call `nxis_list_in_app` with `preview` `true`. It changes nothing. If `listed_in_app` is false, the site isn't in the app: say so in one line, and offer listing (**agentic-site-onboarding**, step 13) only if the user wants it.

If it is listed, read `as_listed` and confirm what people searching the app will meet:

| Field | Should be |
|---|---|
| `title` | The site's name, not a domain. If it's a domain, offer `nxis_set_site_name` |
| `verticals` | The kinds of thing the site is, as `nxis_list_types` reported them in step 4 |
| `places` | Where the site's businesses are, when it has any |
| `capabilities` | What people can do from the app; empty means browse only |
| `discovery_files_link_card` | `true` now that step 4 passed. Still `false` means the app read the files before the deploy; it rechecks within minutes |

Pass on each `next` note. Then tell the user how to try it: add the **NxisAI Hub** app in Claude (Connectors) or ChatGPT (Apps), and ask for what the site offers, by name or by category and place ("electricians in Royal Oak"). If the site isn't public, they must sign in to the app first: in Claude, that means connecting at the app's sign-in address, which ends in `/mcp?sign_in=1`.

## Best practices

- Publish both documents. An agent that reads only one still finds the site
- Merge into an existing `ai-catalog.json` — other tools write to it too
- Confirm through `nxis_list_types` rather than through the file fetch. One proves the document is served, the other proves the server behind it works
- If the type list comes back empty, the site is enabled but has nothing published — say that rather than reporting success
- Read the names in a generated document before publishing it. The generator is not always right about which site it is describing
- For a site listed in the NxisAI app, check it as the app shows it (`nxis_list_in_app`, `preview` `true`), not only as its own server answers

## Anti-patterns

- Publishing a catalog for a site whose MCP server is not enabled. It advertises an endpoint that will refuse every agent that finds it
- Overwriting an existing `ai-catalog.json`. It is shared with other tools by design
- Publishing a document that names the organization, or any host but the site's
- Writing to `.well-known/` without checking the framework serves it
- Reporting success on a written file. Written is not deployed, and deployed is not answering

## Worked example

**User:** "Can agents find my site's MCP server?"

**Step 1.** `nxis_aio_files` for example.com. Returns both documents and an MCP endpoint, and every name in them is example.com.

**Step 2.** `public/.well-known/mcp/catalog.json` does not exist — write it. `ai-catalog.json` does, with one entry from another tool — keep it, append the NxisAI entry, show the diff.

**Step 3.**

> Both files are written. Deploy, and I'll check they're live and that the server behind them answers.

**Step 4.** After the deploy, fetch the catalog, connect to the advertised endpoint, call `nxis_list_types`.

> Agents can now discover example.com on their own. The server reports **Product** (128), **Article** (40), **Organization** (1).
>
> Anything that reads .well-known will find it without being given the URL.

**Step 5.** `nxis_list_in_app` with `preview` `true`: listed, as **Example Outfitters** under Product, browse only, and the discovery files link the server.

> It's in the NxisAI app too, as Example Outfitters. Try it: add the NxisAI Hub app in Claude or ChatGPT and ask for "outdoor gear from Example Outfitters".

## Composing with other skills

This skill composes with:

- **agentic-site-onboarding** — runs before this, enables the server, and writes these documents on first setup. After onboarding, steps 1 and 2 here find the files already in place; step 4 is what this skill still adds
- **on-page-agent** — the in-page reader of what this skill publishes. Its `connectTools()` follows `ai-catalog.json` to the server card and brings the server's typed retrieval tools onto the site's own pages
- **typed-retrieval** — what to use once connected. Discovery ends at a working endpoint and a type list; querying it is that skill's job
- The **action skills** — Lead Funnel Quote, Reservation, Application — when the server exposes write tools. A discovered server with actions bound is exactly what those skills need, and they cannot run against a site they cannot reach

Hand off the MCP endpoint and the type list from step 4. Between them they tell the next skill where to go and what is there, which is everything it needs to start.

This skill owns **being findable**. It does not query the data and it does not set the site up.

## Tool reference

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_aio_files` | The generated discovery documents and their paths | `site` |
| `nxis_list_types` | The types the site's MCP server serves, with counts | none |
| `nxis_list_in_app` | With `preview` `true`, how the NxisAI app lists the site; changes nothing | `site` |

`nxis_aio_files` and `nxis_list_in_app` run on the provisioning connection. `nxis_list_types` runs against the site's own MCP server — the one the catalog advertises — which is why step 4 proves the chain rather than restating it.
