# Vercel

**Status: draft.** Written from Vercel's documented behavior, not yet run end to end. It becomes verified when the Copperline replay on Vercel passes; until then, tell the user you are using a draft profile, and confirm each item marked **Unconfirmed** against Vercel's current documentation before relying on it.

Detect: `vercel.json` or `.vercel/` in the project.

## 1. Where server code lives, and what it runs on locally

It depends on the framework:

- **Next.js, not a static export** — a Route Handler, `app/api/agent/route.ts`, exporting `POST`. The core goes beside it or in `src/lib/`
- **Other frameworks, or plain static sites** — a Vercel Function in the root `api/` directory, `api/agent.ts`, using the Web signature (`export async function POST(request: Request)`)
- **Next.js with `output: "export"`** — Route Handlers are not built in a static export. **Unconfirmed:** whether a root `api/` function deploys beside a Next.js static export under the Next.js framework preset. If it does not, the choice is dropping `output: "export"` for the Vercel build, which Vercel serves natively; put that to the user, since it changes how the site is built

```ts
// app/api/agent/route.ts  (Next.js)  — or api/agent.ts elsewhere
import Anthropic from "@anthropic-ai/sdk";
import { answerTurn } from "@/lib/agent-core";

/** Full origins, as browsers send them. Every one's host must be in the site tag token. */
const ALLOWED_ORIGINS = ["https://example.com", "http://localhost:3000"];

export async function POST(req: Request) {
  // The key is a server-only environment variable, set as Sensitive.
  return answerTurn(req, { anthropic: new Anthropic(), allowedOrigins: ALLOWED_ORIGINS });
}
```

Locally, `next dev` serves Route Handlers on **`http://localhost:3000`**, and `vercel dev` serves root `api/` functions, also on 3000 by default. The page and the endpoint share that origin, which goes in `ALLOWED_ORIGINS`; the token's `localhost` covers it.

## 2. Where the model credential comes from

A project environment variable, `ANTHROPIC_API_KEY`, marked **Sensitive** and scoped to Production (and Preview only if previews should run the agent). `new Anthropic()` reads it. Never prefix it `NEXT_PUBLIC_`: that inlines it into the client bundle.

**Unconfirmed:** Vercel's AI Gateway as the alternative — whether it serves an Anthropic-compatible endpoint the Anthropic SDK can reach through `baseURL`, and how it authenticates from a function. If it does, it removes the need for a vendor key, as Netlify's gateway does.

## 3. The rate-limit primitive

The **Vercel Firewall**: a custom rule on the path `/api/agent`, rate-limited per IP, 20 requests a minute. Rules in the firewall are enforced before the function runs.

**Unconfirmed:** which plans include firewall rate limiting, and the `@vercel/firewall` package's `checkRateLimit` for enforcing a firewall rule from code. If the project's plan has neither, the fallback is a counter in a store with per-key expiry, checked in the adapter before `answerTurn` — slower and costlier than an edge rule, and worth telling the user.

## 4. How to prove the limit is active

The burst from step 6: `windowLimit + 1` empty POSTs from an allowed Origin inside the window — 400s, then a 429. Then confirm the rule shows traffic in the Firewall view of the project.

## Guardrails at the proxy

**Status: draft**, like the rest of this profile. The core is verified by the skill's scripted tests; the adapter below type-checks against `@vercel/edge-config`, and nothing here has run on Vercel.

**Where the policy lives:** Vercel **Edge Config**, item `agentGuardrails` (the document as a JSON value). Edge Config is read at request time and changes with no deploy, from the dashboard or the API. `AGENT_GUARDRAILS` (an environment variable) is the fallback; a changed variable reaches functions only on the next deploy. **Unconfirmed:** Edge Config's propagation delay after a write (documented as seconds), which is how long "the next request" really is here.

**The conversation secret:** `AGENT_CONVERSATION_SECRET`, a Sensitive environment variable.

**The client IP:** the first address in `x-forwarded-for`, which Vercel sets. **Unconfirmed:** whether Vercel replaces rather than appends to a caller's own `x-forwarded-for`; if it appends, use `x-real-ip`.

```ts
// app/api/agent/route.ts (Next.js), with guardrails
import Anthropic from "@anthropic-ai/sdk";
import { get } from "@vercel/edge-config";
import { answerTurn } from "@/lib/agent-core";
import { envSource, proxyGuardrails, type PolicySource } from "@/lib/agent-guardrails";

const ALLOWED_ORIGINS = ["https://example.com", "http://localhost:3000"];

/** The policy in Edge Config: change it there, no deploy. */
const edgeConfig: PolicySource = async () => ((await get("agentGuardrails")) as object | undefined) ?? null;

// Module scope, so counts outlive a request (per instance; the Firewall rule stays the outer bound).
const guardrails = proxyGuardrails({
  sources: [edgeConfig, envSource("AGENT_GUARDRAILS")],
  secret: process.env.AGENT_CONVERSATION_SECRET,
});

const handle = (req: Request) =>
  answerTurn(req, {
    anthropic: new Anthropic(),
    allowedOrigins: ALLOWED_ORIGINS,
    guardrails,
    client: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
  });

// GET serves the policy copy the page reads (guardrails-src="/api/agent").
export const GET = handle;
export const POST = handle;
```

Add `@vercel/edge-config` and `@nxisai/agent-harness` (0.14.0 or later). Connect the Edge Config store to the project, which sets `EDGE_CONFIG`.

## Also on Vercel

- A spending ceiling: Vercel's spend management covers function usage. The model vendor's own spending limit covers the model calls when the key is the vendor's
- Preview deployments get their own `*.vercel.app` hosts, which the site tag token does not list, so the agent has no page tools on previews. That is expected
