---
name: on-page-agent
display_name: On-Page Agent
icon: chat-bubble-left-right
source: NXISAI
description: >
  Add @nxisai/agent-harness to a site: mount the agent, choose where its model
  runs, give it the page's WebMCP tools and the site's MCP server, brand it,
  and prove it answers on the live site. Use once the site tag is installed
  and the user wants an agent on their pages.
license: Apache-2.0
compatibility: >
  Any host and any framework that renders HTML. Needs @nxisai/agent-harness
  0.13.0 or later for the `<nxis-agent>` element; a project pinned below 0.13
  (0.2.4 or later) keeps `<nxis-agent-fullscreen>` until it upgrades. A remote
  model needs a host that runs server code.
metadata:
  author: nxisai
  version: 1.1
  type_group: _integration
  harness_min: 0.13.0
allowed_tools:
  - nxis_list_types
  - nxis_mcp_settings
  - nxis_on_page_agent
enabled: true
---

Put an agent on the site's own pages: `<nxis-agent>` from `@nxisai/agent-harness`, calling the tools the site tag registered from the site's forms, reading the site's typed data through its MCP server, and collecting whatever a form still needs before a write goes through — so a visitor can book a visit by describing the problem.

The harness decides what to draw from the tool and the gaps: a read with nothing missing just runs, a write with nothing missing still gets a confirm card, and a write with several gaps becomes a stepper. This skill's job is everything around that — where the model runs, how the element gets onto the page, what it can reach, and proof that it works where visitors will use it.

## When this skill applies

Use this skill when **all** of the following are true:

- The site tag is installed and registers tools — normally by **site-tag-installation** — or the site at least publishes its MCP discovery documents
- You are running in the project that builds the site, and the user can deploy it
- The user wants an agent on their own pages

Do not use this skill for:

- A site with no tag and no discovery documents. The agent would have nothing to call; start with **site-tag-installation**
- Writing the server endpoint for a remote model. That is **agent-model-proxy**, which this skill calls in step 2
- Making the site findable by agents elsewhere. That is **mcp-discovery-publishing**
- Answering support questions from the site's help content with cited answers. That is **support-agent**, a handoff target behind this agent

## The pattern, in seven steps

### Step 1 — Check the agent will have something to call

The agent's tools come from two places, and it needs at least one:

- **The page's own tools** — the site tag registers each of the site's Actions as a WebMCP tool. On a page whose host the tag's token allows, `await document.modelContext.getTools()` lists them
- **The site's MCP server** — the element reads `/.well-known/ai-catalog.json`, falling back to `/.well-known/mcp/catalog.json`, and brings the server's typed retrieval tools onto the page

If the tag is not installed, or registers nothing, run **site-tag-installation** first. An agent with no tools opens, looks right, and answers every question with "No tools are registered on this page yet".

Note the tool names. Step 6 routes between them.

### Step 2 — Decide where the model runs, with the user

This is the one decision that changes what the agent is. Put it to the user with both sides:

| | Remote, through a proxy | On-device |
|---|---|---|
| Where the model runs | Behind server code on the site's own host | In the visitor's tab, over WebGPU |
| First open | Instant; nothing downloads | Gigabytes of weights, fetched once and cached |
| Phones | Work | Most cannot hold the weights; the tab is killed, and the visitor loses the page, not just the agent |
| Conversations | Leave the device. The header badge reads **Remote** | Stay in the tab. The badge reads **On-device** |
| Cost | A model call per turn, on the user's account | None per turn |
| Needs | A host that runs server code | WebGPU with `shader-f16` |

The default follows from the host:

- **If the host runs server code, recommend remote,** and run **agent-model-proxy** now. It asks for its own consent to the spend, writes the endpoint, and hands back its path. Come back here with it
- **If the host serves static files only, on-device is the option.** Gate the element on `assessLocalCapability()` so a device that cannot hold the model is never offered a launcher. The failure it prevents cannot be caught: an out-of-memory kill runs no `catch`, and takes the page down with it

Say what the badge will read, either way. The package's claim is that nothing leaves the tab unless the page says so, and the badge is how it says so.

### Step 3 — Install the harness

```bash
npm install @nxisai/agent-harness@^0.13.0
```

0.13.0 is the first version with the `<nxis-agent>` element this skill mounts. Below 0.2.4 nothing in this skill is safe: those versions look for a fallback catalog the site does not publish, and read an MCP key from the page's markup, which put a credential in front of every visitor.

**If the project already has the harness, read the version it resolves, not the range.** `npm ls @nxisai/agent-harness`, or the entry in the lockfile, gives it; a range such as `^0.12.0` in `package.json` never reaches 0.13, since a caret below 1.0 holds the minor. Then:

- **0.13.0 or later:** mount `<nxis-agent>`. If the project mounts `<nxis-agent-fullscreen>`, that is the element's old name, kept as a deprecated alias: it opens full screen when no `mode` is set, and logs a warning. Rename it to `<nxis-agent mode="fullscreen">` to keep full screen, or to `<nxis-agent>` for the window default, and rename the tag in selectors, `customElements.get` and `whenDefined` calls, and CSS too
- **0.2.4 to 0.12.x:** ask the user whether to upgrade. Upgrading is `npm install @nxisai/agent-harness@^0.13.0`, then the rename above. Keeping the version means `<nxis-agent-fullscreen>` wherever this skill says `<nxis-agent>`: the same attributes and properties, `mode` included, but full screen by default, no header toggle, no `no-mode-toggle` or `nxis-mode-change`, and no exported element class, so type it by hand
- **Below 0.2.4:** upgrade; there is no keeping it

Never mount `<nxis-agent>` on a version below 0.13. The tag is unknown there: nothing renders and nothing errors. In the browser console, `customElements.get("nxis-agent")` returns `undefined` on those versions.

**Commit the lockfile, and redeploy after any version change.** A range that resolves to a fixed version locally still ships whatever the last deploy's build resolved. A fix is not in production until the host rebuilds.

### Step 4 — Mount the element

**A site with a bundler and no server render** — Vite, Parcel, a plain SPA:

```js
import "@nxisai/agent-harness/ui";
import { createProxyProvider } from "@nxisai/agent-harness";

const agent = document.querySelector("nxis-agent");
agent.modelProvider = createProxyProvider({ endpoint: "/api/agent" });
```

```html
<nxis-agent></nxis-agent>
```

**The `mode` attribute chooses the layout:**

| `mode` | Layout |
|---|---|
| `window` (the default) | Docked in the corner, 400 × 620 (`--window-w`, `--window-h`). Below 520px wide it covers the page anyway |
| `fullscreen` | Covers the page |
| `inline` | Fills the box the host lays out for it, and stays open: a copilot rail beside the content |

Leave it unset unless the user wants another layout. In `window` and `fullscreen` the header has a button that switches between the two, keeping the conversation. The viewer's choice is remembered, and applies on later loads only where the host set no `mode`: a host's `mode` always wins. Add `no-mode-toggle` to hide the button. Each switch fires `nxis-mode-change` on the element, with `detail.mode`, for a page that wants to follow it.

**A site with no build step at all** — hand-written HTML, a CMS template — cannot use the package's files directly: they import `lit` and the MCP SDK by package name, which a browser cannot resolve. Load it through an ESM CDN that rewrites those imports, such as jsDelivr's `/+esm` endpoints, pinned to an exact version. Confirm in the browser that it loads before relying on it, and tell the user it is the least-traveled path.

**Frameworks that render on a server or at build time** — Next.js, Nuxt, Remix, SvelteKit, Astro — need one rule: **import `@nxisai/agent-harness/ui` only in the browser.** The element defines itself when the module loads, and a module-scope import runs that during the server render or the static build. Import it inside the framework's client-only hook: `useEffect` in React, `onMounted` in Vue, `onMount` in Svelte, a client `<script>` in Astro.

In Next.js, a client component rendered once in the root layout:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { createProxyProvider } from "@nxisai/agent-harness";
// A type-only import is erased from the build, so it is safe at module scope.
import type { NxisAgent } from "@nxisai/agent-harness/ui";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "nxis-agent": React.DetailedHTMLProps<React.HTMLAttributes<NxisAgent>, NxisAgent> & {
        mode?: "window" | "fullscreen" | "inline";
      };
    }
  }
}

export function SiteAgent() {
  const ref = useRef<NxisAgent>(null);

  useEffect(() => {
    let canceled = false;
    // The element defines itself on import, so the import stays in the browser.
    void import("@nxisai/agent-harness/ui")
      .then(() => {
        const agent = ref.current;
        if (canceled || !agent) return;
        // First: until this lands, the element holds a local provider.
        agent.modelProvider = createProxyProvider({ endpoint: "/api/agent" });
        agent.name = "Example Assistant";
        agent.emptyState = "Ask about our services, or book a visit.";
        agent.suggestions = ["What areas do you cover?", "Book a visit"];
      })
      .catch((error: unknown) => {
        // A visitor who cannot load the agent loses the agent, not the page.
        console.warn("[site] on-page agent unavailable:", error);
      });
    return () => {
      canceled = true;
    };
  }, []);

  return <nxis-agent ref={ref} />;
}
```

Three things hold in every framework:

- **Set `modelProvider` before anything else** when the model is remote. Until it is set, the element holds the local provider it builds on connect
- **Render it behind the same switch as the site tag.** Its tools are the tag's tools. With the tag off, render no agent, rather than a launcher that can do nothing
- **Leave `modelProvider` unset for on-device**, and render the element only once `assessLocalCapability()` resolves `ok`

### Step 5 — Let it reach the site's MCP server

Nothing to add. On first open the element reads the site's discovery documents, follows them to the MCP server, and bridges its public tools — `nxis_query`, `nxis_get`, `nxis_list_types` — into the page's tool list, beside the tag's form tools. It does this once, on first open, so a launcher nobody opens costs no request.

What to check, and what not to do:

- **The discovery documents are served** from the page's own origin, as valid JSON. **agentic-site-onboarding** writes them; **mcp-discovery-publishing** confirms them
- **Pass no key.** The element takes none, and no key belongs in the page. Private tools go behind an endpoint the site hosts
- **Set `discover="false"` only on a site that publishes no catalog.** It saves one failed request on first open, and nothing else
- Remove any comment or setting in the project that says the catalog is absent once it is published

With `debug` on, the browser console reports `[nxis-agent] discovered remote tools: …` on first open. That line is the check.

### Step 6 — Brand it and scope what each turn carries

**Branding.** `name`, `logo` (inline SVG or an image URL), `theme`, `emptyState` and `suggestions` are the site's. Point `theme` at the site's own palette and fonts. Write the empty state about what a visitor to this site arrives wanting — the packaged one describes the mechanism, and only the site knows the subject. The "Powered by NxisAI" footer stays whatever the branding.

**The prompt.** If you replace `systemPrompt`, keep the packaged prompt's two working lines: call the tool as soon as it is clear which one is right, with the fields known so far; and never ask for a missing field in prose. The harness collects missing fields as fields. A prompt that asks in prose produces a paragraph of questions instead.

**Specialists, once the tools pass about six.** Every turn resends every tool's definition, and most of what the model reads is tool schemas. Split into `agents` — retrieval, booking, quote, forms, whatever the site's tools group into — each with its own prompt and only its own tools, plus `routes` and a `fallback`. Route anything unclear to retrieval: a question is the common case, and it is the one agent that cannot submit anything on someone's behalf. Match the tag's form tools by pattern, since the tag names them in the browser; match retrieval tools by exact name.

**Teach the retrieval agent the corpus.** Call `nxis_list_types` on the site's MCP server and put the types it reports, with the filter syntax, into the retrieval prompt. The tool schema cannot teach which types exist, or which field paths are worth filtering on.

Leave `debug` off in production. Its receipts show the arguments the model chose, which include whatever a visitor typed into a form.

### Step 7 — Deploy, then prove the chain on the live site

Tell the user to deploy. On the production origin, check each link, because each one fails silently on its own:

1. **Tools:** `await document.modelContext.getTools()` lists the tag's tools, and after the first open, the MCP server's too
2. **Badge:** the header reads Remote or On-device, as the user chose in step 2
3. **Endpoint:** for a remote model, **agent-model-proxy**'s production checks passed — 200 from the site's origin, 403 from any other, and the rate limit proven with a burst
4. **A read:** a question about the site answers from its data, through `nxis_query`
5. **A write:** a request that needs a form — booking, quote — ends in the harness's fields or confirm card, not in prose
6. **A phone:** one complete conversation on a real phone. It is where an on-device model fails, and where a layout nobody checked is usually found
7. **A handoff:** open a page with a form at its address plus `?nxis_handoff=<the form's action @id>` (the `@id` of the action in that page's JSON-LD). The agent opens on that form's card on the first load, without a message from the visitor, and the parameter leaves the address bar

Once all seven pass, call `nxis_mcp_settings`: if `on_page_agent` is already on, say so and stop. Otherwise ask the user whether to tell NxisAI that the site runs the agent, and on a yes call `nxis_on_page_agent`. From then on, links from the NxisAI app and from agents reading the site's records name the action, and land in this agent instead of on a bare page. Never turn it on before check 7 passes on production: a link that names an action the page can't open is worse than a plain link.

Report what was checked, not that the files were written. Then offer **mcp-discovery-publishing** if the server side has not been confirmed.

## Best practices

- Put the remote-or-on-device choice to the user with both sides. It decides where their visitors' conversations go
- Run **agent-model-proxy** in the middle of this skill, not after it. The mount needs the endpoint's path
- Import the element in the browser only
- Keep the agent behind the site tag's switch
- Let the element discover the site's MCP server itself
- Split into specialists once the tool list is long, and route unclear turns to retrieval
- Prove it on production and on a phone

## Anti-patterns

- Mounting the agent on a site whose tag registers nothing. It will answer every turn with "No tools are registered on this page yet"
- Mounting `<nxis-agent>` on a project whose harness resolves below 0.13. The tag is unknown there, and the page shows nothing
- Defaulting to on-device without saying what it costs a phone, or to remote without saying conversations leave the device
- Importing `@nxisai/agent-harness/ui` at module scope in a server-rendered or statically built framework
- Setting the provider after the other properties, or not at all, for a remote model
- Passing an MCP key to the element, or putting one anywhere in the page
- Rewriting the prompt to ask for missing fields in prose
- Shipping with `debug` on
- Reporting the agent working because it opens. Opening is the one part that never fails

## Worked example

**User:** "The tag's in. Can we put an agent on the site?"

**Step 1.** On `http://localhost:8888`, `getTools()` returns four tools: book a visit, request a quote, contact, newsletter. The site publishes `ai-catalog.json`.

**Step 2.** The project is a Next.js static export on Netlify, which runs functions.

> Your agent's model can run on your server or in each visitor's browser. On your server, it opens instantly and works on phones, but conversations leave the visitor's device, and each one costs a model call. In the browser, conversations stay private, but it downloads gigabytes on first open and most phones can't run it. I'd recommend the server. Which would you like?

They choose the server. **agent-model-proxy** runs, gets its own consent to the spend, and hands back `/api/agent`.

**Step 3.** The project has no harness yet. `npm install @nxisai/agent-harness@^0.13.0`; the lockfile is committed.

**Step 4.** `src/components/site-agent.tsx`, rendered in `src/app/layout.tsx` behind `NEXT_PUBLIC_NXIS_ENABLED`, with `createProxyProvider({ endpoint: "/api/agent" })` set first. No `mode`: it opens as a window in the corner, and visitors can expand it.

**Step 5.** Nothing to add. The catalog is served.

**Step 6.** Named for the business, with its logo and palette. Four form tools plus three retrieval tools is past six, so four specialists: retrieval, booking, quote, forms, with retrieval as the fallback. `nxis_list_types` reports `Service`, `Plumber`, `FAQPage` and `Review`, and those go into the retrieval prompt with the filter syntax.

**Step 7.** After the deploy, on example.com: seven tools after first open; the badge reads Remote; the proxy's checks pass; "do you cover Evanston?" answers from the corpus; "my basement is flooding, can someone come today?" ends in the booking stepper; the same conversation completes on a phone.

> Your agent is live on every page. It answers from your site's data, books visits and takes quote requests through your own forms, and runs on your server, so phones work. I tested each of those on example.com just now.

## Composing with other skills

This skill composes with:

- **site-tag-installation** — runs before this. The tools it registers are this agent's toolset
- **agent-model-proxy** — runs in the middle of this, at step 2, when the model is remote. It owns the endpoint; this skill points `createProxyProvider` at it
- **agentic-site-onboarding** and **mcp-discovery-publishing** — publish and confirm the discovery documents step 5 relies on
- **typed-retrieval** — the query patterns the retrieval specialist's prompt should teach
- **support-agent** — a handoff target for support questions. With `agent.agents`, `transfer_to_agent` goes in the slice that handles questions, and `talk_to_a_person` in every slice
- **agent-handoff** — the relay behind `agent.handoff`, and its targets: a person at a desk, or an agent that finishes a job. **quote-agent** adds `quote` and **booking-agent** adds `booking`, each taking its form's place with `takes`; put `transfer_to_agent` in the slice of the specialist whose form it takes
- **The host's own skills**, when the project has them installed, for deploys

This skill owns **the agent on the page**: the mount, the provider choice, the branding, the routing, the proof, and telling NxisAI the agent is there (`nxis_on_page_agent`). It does not write the model endpoint, install the tag, or change the site's data.

## Tool reference

| Tool | Purpose | Required input |
|---|---|---|
| `nxis_list_types` | The types the site's MCP server serves, for the retrieval prompt | none |
| `nxis_mcp_settings` | Read the site's settings, `on_page_agent` among them, before changing it | `site` on the provisioning endpoint |
| `nxis_on_page_agent` | Say the site's pages run the agent, so links to its forms hand the action to it | `site` on the provisioning endpoint; `enabled` defaults to true |

`nxis_list_types` runs against the site's own MCP server; `nxis_mcp_settings` and `nxis_on_page_agent` on the provisioning connection. Everything else in this skill is files in the project and checks in the browser.
