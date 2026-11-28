# Cloudflare

**Status: draft.** Written from Cloudflare's documented behavior and not run end to end; it ships as a draft in 1.0. Tell the user you are using a draft profile, and confirm each item marked **Unconfirmed** against Cloudflare's current documentation before relying on it.

Detect: `wrangler.toml` or `wrangler.jsonc` in the project.

## 1. Where server code lives, and what it runs on locally

Two shapes, depending on how the site is deployed:

- **Workers with static assets** — one Worker serves the site's built files and the endpoint. Its `fetch` handler answers `POST /api/agent` and hands everything else to the assets binding
- **Pages Functions** — a file at `functions/api/agent.ts` exporting `onRequestPost`, deployed beside the Pages site

```ts
// Workers with static assets: src/worker.ts
import Anthropic from "@anthropic-ai/sdk";
import { answerTurn } from "./agent-core";
import { proxyGuardrails, type ProxyGuardrails } from "./agent-guardrails";

interface Env {
  ANTHROPIC_API_KEY: string;
  AGENT_CONVERSATION_SECRET?: string;
  AGENT_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  ASSETS: { fetch(req: Request): Promise<Response> };
}

/** Full origins, as browsers send them. Every one's host must be in the site tag token. */
const ALLOWED_ORIGINS = ["https://example.com", "http://localhost:8787"];

// Built from the first request's env, once per isolate. With no policy source, the built-in defaults.
let guardrails: ProxyGuardrails | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/api/agent") return env.ASSETS.fetch(req);
    // GET serves the policy copy the page reads (guardrails-src="/api/agent").
    if (req.method !== "POST" && req.method !== "GET") return new Response(null, { status: 405 });

    // Per client, before any work. The binding counts per location, not globally.
    const key = req.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.AGENT_LIMITER.limit({ key });
    if (!success) return Response.json({ error: "Too many requests." }, { status: 429 });

    guardrails ??= proxyGuardrails({ sources: [], secret: env.AGENT_CONVERSATION_SECRET });
    return answerTurn(req, {
      anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      allowedOrigins: ALLOWED_ORIGINS,
      guardrails,
      client: key,
    });
  },
};
```

`agent-guardrails.ts` goes beside `agent-core.ts`; Guardrails at the proxy, below, adds a KV namespace as the policy's source.

Locally, `wrangler dev` serves a Worker on **`http://localhost:8787`**; `wrangler pages dev` serves Pages on **`http://localhost:8788`**. Whichever the project uses goes in `ALLOWED_ORIGINS`; the site tag token covers it with `localhost`, since it ignores ports.

**Unconfirmed:** that the Anthropic SDK runs in the Workers runtime without the `nodejs_compat` flag, and that `req.signal` aborts when the visitor's connection closes, which the core relies on to stop the upstream call.

## 2. Where the model credential comes from

A Worker secret: `wrangler secret put ANTHROPIC_API_KEY`, read as `env.ANTHROPIC_API_KEY`. Workers have no ambient `process.env` by default, which is why the adapter passes the key explicitly. Locally, `.dev.vars` holds it, and `.dev.vars` goes in `.gitignore`.

**Unconfirmed:** Cloudflare's AI Gateway in front of the vendor, reached by setting the Anthropic client's `baseURL` to the gateway's Anthropic endpoint for the account. It adds logging and caching at Cloudflare; the vendor key is still needed.

## 3. The rate-limit primitive

The Workers **Rate Limiting binding**, declared in the Wrangler config and called in the adapter before `answerTurn`, as above:

```jsonc
// wrangler.jsonc
"ratelimits": [
  { "name": "AGENT_LIMITER", "namespace_id": "1001", "simple": { "limit": 20, "period": 60 } }
]
```

**Unconfirmed:** the config key names, and the allowed values for `period`, against the current Wrangler schema. The binding counts per Cloudflare location rather than globally, so the real ceiling for a client spread across locations is looser than the number — acceptable here, and worth saying.

The binding runs inside the Worker, so unlike an edge rule it costs an invocation per refused request. It still refuses before the model call, which is the expensive part.

## 4. How to prove the limit is active

The burst from step 6: `limit + 1` empty POSTs from an allowed Origin inside the period — 400s, then a 429. The binding answers from inside the Worker, so there is no deploy-log failure mode like Netlify's; a missing binding throws at the first request instead, which the burst also catches.

## Guardrails at the proxy

**Status: draft**, like the rest of this profile. The core is verified by the skill's scripted tests; the adapter below type-checks, and nothing here has run on Workers.

The adapter in section 1 already builds the guardrails, so with no policy they run the built-in defaults. This adds a policy the site can change.

**Where the policy lives:** a **KV namespace**, key `policy`: `wrangler kv key put --binding AGENT_GUARDRAILS policy --path guardrails.json` changes it with no deploy. **Unconfirmed:** KV is eventually consistent, documented as up to about a minute across locations, so "the next request" is the next one after the change has propagated; the exact command flags against the current Wrangler.

**The conversation secret:** `wrangler secret put AGENT_CONVERSATION_SECRET`.

**The client IP:** `cf-connecting-ip`.

Workers have no `process.env`, so the guardrails are built from the first request's `env`, once per isolate; counts live in the isolate's memory, and the rate-limit binding stays the outer bound. `crypto.subtle` and `btoa`, which the conversation ids use, are part of the Workers runtime.

```ts
// src/worker.ts, with guardrails
import Anthropic from "@anthropic-ai/sdk";
import { answerTurn } from "./agent-core";
import { proxyGuardrails, type ProxyGuardrails } from "./agent-guardrails";

interface Env {
  ANTHROPIC_API_KEY: string;
  AGENT_CONVERSATION_SECRET?: string;
  AGENT_GUARDRAILS: { get(key: string): Promise<string | null> };
  AGENT_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  ASSETS: { fetch(req: Request): Promise<Response> };
}

const ALLOWED_ORIGINS = ["https://example.com", "http://localhost:8787"];

let guardrails: ProxyGuardrails | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/api/agent") return env.ASSETS.fetch(req);
    // GET serves the policy copy the page reads (guardrails-src="/api/agent").
    if (req.method !== "POST" && req.method !== "GET") return new Response(null, { status: 405 });

    const key = req.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.AGENT_LIMITER.limit({ key });
    if (!success) return Response.json({ error: "Too many requests." }, { status: 429 });

    guardrails ??= proxyGuardrails({
      sources: [() => env.AGENT_GUARDRAILS.get("policy")],
      secret: env.AGENT_CONVERSATION_SECRET,
    });
    return answerTurn(req, {
      anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      allowedOrigins: ALLOWED_ORIGINS,
      guardrails,
      client: key,
    });
  },
};
```

```jsonc
// wrangler.jsonc, beside the rate limit
"kv_namespaces": [{ "binding": "AGENT_GUARDRAILS", "id": "<the namespace id>" }]
```

**Unconfirmed:** that `@nxisai/agent-harness/policy` bundles for Workers with no `nodejs_compat` (it uses no Node APIs).

## Also on Cloudflare

- A spending ceiling: the model vendor's own spending limit covers the model calls. Workers usage has its own billing
- Preview deployments run on their own hosts, which the site tag token does not list, so previews have no page tools. That is expected
