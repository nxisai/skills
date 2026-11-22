---
name: site-tag-installation
display_name: Site Tag
icon: 🏷️
source: NXISAI
description: >
  Install the NxisAI site tag in a verified site's project so every page
  carries its Schema.org JSON-LD and registers its Actions as WebMCP tools,
  with a token in browser mode for the right domains. Use after onboarding, or
  when an on-page agent finds no tools.
license: Apache-2.0
compatibility: >
  Any host. Needs a site verified by agentic-site-onboarding; the user deploys.
metadata:
  author: nxisai
  version: 1.0
  type_group: _integration
allowed_tools:
  - nxis_verify_site
  - nxis_site_tag
enabled: true
---

Put a verified site's structured data and actions onto its own pages: the JSON-LD NxisAI generated, injected into every page, and each of the site's Schema.org Actions registered as a WebMCP tool that an agent in the browser can call.

Onboarding gives the site an MCP server that agents reach from outside. This skill is the other half — the same data on the page itself, where a browser agent, or the site's own **on-page-agent**, finds it without leaving the tab.

## When this skill applies

Use this skill when **all** of the following are true:

- The site is verified — normally by **agentic-site-onboarding**
- You are running in the project that builds the site, and the user can deploy it
- The user wants the site's structured data or actions on its own pages, or an on-page agent that reports no tools

Do not use this skill for:

- A site that is not verified yet. That is **agentic-site-onboarding**, which has to finish first
- Mounting an agent on the page. That is **on-page-agent**, which needs this skill done first
- Making the site discoverable to agents outside the page. That is the MCP server and **mcp-discovery-publishing**

## The two ways onto the page

Which one a project takes depends on whether it renders pages on a server at request time.

| | CDN tag | Server-side (`NxisClient`) |
|---|---|---|
| Suits | Static sites, static exports, client-rendered apps, CMS templates | Frameworks that render on a server: Next.js SSR, Nuxt, Remix, SvelteKit, Astro SSR, Express |
| JSON-LD arrives | In the browser, after the script runs | In the initial HTML response |
| Actions become tools | The tag registers them, when its token says `webmcp.mode: "browser"` | `registerActions()` from `@nxisai/nxis/webmcp`, in a client-only hook |
| Credential | A public site token, locked to a list of domains, safe to commit | OAuth client credentials, which are secrets and live only in server environment variables |

Two things decide it:

- **A project with no request-time rendering takes the CDN tag.** A static export (`output: "export"` in Next.js, or any site built to plain files) has no server step for `NxisClient` to run in. Injecting at build time instead leaves the graph one deploy behind forever, since every regeneration needs another build
- **A server-rendered project can take either, and should hear the trade.** Server-side puts the JSON-LD in the HTML that crawlers and LLM agents read without running JavaScript; the CDN tag is one line and needs no secret. Put that to the user rather than choosing for them

The steps below follow the CDN tag, which is the common path and the one this skill's token checks exist for. For the server-side path, the credential is a client id and secret instead of a token: store them as server environment variables, never with a public prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`), and add a client component that calls `registerActions()` after hydration. Steps 1, 5 and 6 apply unchanged.

## The pattern, in six steps

### Step 1 — Confirm the site is verified

Call `nxis_verify_site` with `mode` set to `check` and the site id.

If it is not verified, **stop and hand back to agentic-site-onboarding.** The tag always comes after verification: a tag on an unverified site serves nothing, and a token should never be issued for a host nobody has proven they own.

### Step 2 — Find where head tags live

Look for where the project already puts things in the HTML head — a root layout, a base template, a head component, a theme's header — and put the tag there. The verification META from onboarding is usually the clearest signpost.

Put it behind a build-time switch that omits it entirely, such as `NEXT_PUBLIC_NXIS_ENABLED=false` in Next.js. A site with and without the tag is the easiest comparison there is when someone asks what it does, and a way to take it out without a code change is worth having before anything goes wrong.

Add a `preconnect` to `https://cdn.nxis.ai` beside it, and load the script `async` with `crossorigin="anonymous"`:

```html
<link rel="preconnect" href="https://cdn.nxis.ai">
<script async src="https://cdn.nxis.ai/nxis.js?token=TOKEN" crossorigin="anonymous"></script>
```

### Step 3 — Decide which hosts the token allows

The token only activates on the hosts it lists. Anywhere else the tag answers "Domain Unauthorized", injects nothing and registers no tools — including on the developer's own machine, which is how a missing entry is usually found.

The CDN compares **hosts only**. It ignores the scheme and the port, and treats `www.example.com` as `example.com`. So the list is short:

- **The production host** the site was created on in onboarding, e.g. `example.com`
- **`localhost`**, if the site is ever run locally. One entry covers every local port — `next dev` on 3000, `netlify dev` on 8888, `wrangler dev` on 8787 alike

Never `*`: it authorizes the token on every site on the web. Wildcards like `*.example.com` are not honored at all.

Deploy previews do not fit. A preview's host names one deploy, so an entry for it stops matching as soon as the next preview builds. Say so rather than adding one: previews show the site without the tag's tools, and testing happens locally or in production.

### Step 4 — Issue the token and check it before writing it

Call `nxis_site_tag` with `mode` set to `status` first. If the site already has a token, its decoded claims are in the response. If they already say `browser` and list the hosts from step 3, use that token — there is nothing to issue.

Otherwise call it with `mode` set to `issue`, the site id, the hosts from step 3 as `domains`, and `webmcp_mode` set to `browser`. The tool normalizes what you pass — a URL becomes its host, duplicates collapse — and always adds the site's own host, so the token cannot exclude the site it is for. It returns:

| Field | Meaning |
|---|---|
| `token` | The signed token, for the tag |
| `claims` | `site_id`, `webmcp_mode`, `domains` and `expires_at`, read from the signed token itself |
| `changed` | `false` when the existing token already matched, and nothing was re-signed |
| `issued: false`, `reason: site_not_verified` | The site is not verified. Hand back to **agentic-site-onboarding** |

Re-issuing is safe for a live site. The previous token keeps working until it expires, so nothing breaks before the new tag is deployed.

If the tool is not available on the connection, the user issues the token from the NxisAI dashboard with the same settings, and pastes it to you.

Either way, **decode the token yourself and check it before it goes anywhere.** It is a JWT, and its payload is readable without the signing key. The build passes, the tag loads and the page looks right whatever these fields say — so this is the only point where a wrong token is cheap, and it is worth checking even when a tool reports the claims:

| Claim | Must be |
|---|---|
| `config.webmcp.mode` | `browser`. With `none`, the tag injects JSON-LD and registers no tools, and an agent on the page answers "No tools are registered on this page yet" |
| `config.site_id` | The site id from onboarding |
| `domains` | Every host from step 3. An entry written with a scheme or a port, like `https://example.com`, still works — the CDN reduces it to its host |
| `exp` | In the future. Tokens run for a year |

If any claim is wrong, do not write the token. Say which one, and get it reissued.

### Step 5 — Write it in

Put the token in the tag from step 2. It can live in the code: it is a public, domain-scoped token, designed to sit in page HTML where any visitor can read it, and it does nothing on a domain it does not list. Say that when you write it, because committing it looks like a mistake to anyone who knows not to commit keys — and say the difference, that the provisioning key used for onboarding is a secret and is never written into the project.

Allow an environment variable to override it, for pointing the same build at another site.

Write a comment beside it recording what the token cannot be asked later without decoding it:

- The expiry date
- `webmcp.mode`, and what goes wrong if a reissue changes it
- The hosts it allows, and that previews are not among them

Every rotation after this one updates that comment. A comment describing the previous token is how a reissued token with the wrong mode goes unnoticed.

### Step 6 — Deploy, then check it on the live site

Tell the user to deploy. Once it is live, on the production origin:

1. The page source has the script tag, and the script loads rather than answering with a domain error
2. A `<script type="application/ld+json">` has been injected into the head
3. `await document.modelContext.getTools()` returns at least one tool

If the site has forms that are Actions and the third check returns an empty list, the token's mode is the first thing to look at, and its domain list the second.

Then tell the user when the token expires. It is the one thing about this install that will fail on a date.

## Best practices

- Confirm verification first, every time. It is one call, and everything after it assumes it
- Decode the token before writing it. Its mode and domains cannot be seen any other way until something fails
- Include `localhost` if the site is ever run locally. A token without it makes every local test look broken, and one entry covers every port
- Keep the tag behind a switch that removes it at build time
- Write the expiry, mode and domains next to the token, and update them on every rotation

## Anti-patterns

- Issuing or installing a tag for a site that is not verified
- Writing a token whose `webmcp.mode` is not `browser` for the CDN path. Everything will look installed, and no tool will register
- Adding a deploy preview's host to the domain list as if it covered previews. It covers that one deploy
- Putting `*` in the domain list, or listing each local port as if the CDN checked ports
- Putting `NxisClient` credentials in a publicly prefixed environment variable. They are secrets; only the site token is public
- Choosing server-side or CDN for a server-rendered project without telling the user the trade
- Reporting the tag installed because the build passed. Installed is a tool list on the live page

## Worked example

**User:** "Onboarding's done. Can you add the NxisAI tag?"

**Step 1.** `nxis_verify_site` with `mode` `check`. Verified.

**Step 2.** The project is Next.js with `output: "export"`, so it has no request-time rendering and takes the CDN tag. The verification META is in `src/app/layout.tsx`, so the tag goes into that layout's `<head>`, behind `NEXT_PUBLIC_NXIS_ENABLED`.

**Step 3.** Production is `example.com`, and the project is developed locally, so the hosts are `example.com` and `localhost`. One `localhost` covers both `next dev` on 3000 and `netlify dev` on 8888.

**Step 4.** `nxis_site_tag` with `mode` `status`: no token yet. Then `mode` `issue` with those two hosts and `webmcp_mode` `browser`. The claims, and a decode of the token, agree: mode `browser`, the right site id, both hosts, expiring 2027-09-10.

**Step 5.** Written into `src/lib/nxis.ts`, overridable by `NEXT_PUBLIC_NXIS_TOKEN`, with a comment giving the expiry, the mode and the domains.

> The tag is in your root layout. The token is committed on purpose: it's public and only works on example.com and on your own machine. It expires on 2027-09-10, and that date is in the comment above it.
>
> Deploy and I'll check the tools register on the live site. Deploy previews won't have them, because a preview's address changes with every build.

**Step 6.** After the deploy: the script loads, the JSON-LD is in the head, and `getTools()` returns four tools — a booking, a quote request, a contact form and a newsletter signup.

> Your pages now carry your structured data, and four of your forms are callable tools for any agent in the browser. If you'd like an agent of your own on the site that uses them, that's next.

## Composing with other skills

This skill composes with:

- **agentic-site-onboarding** — runs before this and verifies the site, which this skill requires
- **on-page-agent** — the next step. The tools this skill registers are that agent's toolset, and it has nothing to call without them
- **agent-model-proxy** — its endpoint allows full origins, and every one of their hosts has to be in this token, or the agent works in one place and not the other
- **The host's own skills**, when the project has them installed, for deploys and environment variables

Hand off the list of registered tool names from step 6. It is what **on-page-agent** routes between.

This skill owns **the tag and its token**: the install, the domains, the mode and the expiry. It does not verify the site, mount an agent, or change what the structured data says.

## Tool reference

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_verify_site` | `check` confirms the site is verified | `mode`, site |
| `nxis_site_tag` | `status` reads the current token and its claims; `issue` signs one for a verified site | `mode`, site; `domains` and `webmcp_mode` for `issue` |

`nxis_site_tag` runs on the provisioning connection. `status` never changes anything; `issue` refuses a site that is not verified. Where it is not yet available, the token comes from the NxisAI dashboard, and step 4's decode-and-check is how this skill still holds it to the same standard.
