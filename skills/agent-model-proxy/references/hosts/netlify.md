# Netlify

**Status: verified.** Running in production on copperline.nxis.ai (`netlify/functions/agent.mts`), including the rate-limit failure described under question 4.

Detect: `netlify.toml` or `.netlify/` in the project.

## 1. Where server code lives, and what it runs on locally

Netlify Functions, in `netlify/functions/`. Every file directly in that directory is deployed as its own function, so the core cannot sit loose beside the adapter. Use a function directory:

```
netlify/functions/agent/
  agent.mts        ← the adapter; the entry file is named after the directory
  agent-core.ts    ← references/agent-core.ts, unchanged
  agent-guardrails.ts ← references/agent-guardrails.ts, when the site uses guardrails at the proxy
```

This works for static sites and static exports alike: the functions deploy beside the publish directory in `netlify.toml`.

Locally, `netlify dev` serves the site and its functions together on **`http://localhost:8888`**, proxying the framework's dev server. `next dev` on :3000 alone has no `/api/agent`, so the agent is tested on :8888. `ALLOWED_ORIGINS` needs that origin; the site tag token covers it with `localhost`, since it ignores ports.

## 2. Where the model credential comes from

Netlify's **AI Gateway**. It injects `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` into functions at runtime, so `new Anthropic()` with no arguments is correct, and nothing goes in the repository or the project's environment settings.

**Do not set `ANTHROPIC_API_KEY` yourself.** Netlify never overwrites a variable you have set, so a project-level key silently takes over from the gateway. Check `netlify env:list` for one before deploying, and tell the user if it is there.

The gateway serves its own list of models. If it does not yet serve the core's default, set `MODEL` to the newest one it does.

## 3. The rate-limit primitive

`rateLimit` in the function's `config` export. Netlify enforces it at the edge, so a refused request never invokes the function and never reaches the model.

```ts
// netlify/functions/agent/agent.mts
import type { Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { answerTurn } from "./agent-core";

/** Full origins, as browsers send them. Every one's host must be in the site tag token. */
const ALLOWED_ORIGINS = [
  "https://example.com",
  "http://localhost:3000",
  "http://localhost:8888",
];

export default (req: Request) =>
  // AI Gateway injects the credentials at init; no key is set in this project.
  answerTurn(req, { anthropic: new Anthropic(), allowedOrigins: ALLOWED_ORIGINS });

export const config: Config = {
  path: "/api/agent",
  method: ["POST"],
  // Per client, enforced at the edge. aggregateBy must list both keys: the
  // types accept "ip" alone, and the platform then rejects the rule at deploy
  // and ignores every rate-limit rule on the site.
  rateLimit: {
    action: "rate_limit",
    aggregateBy: ["domain", "ip"],
    windowSize: 60,
    windowLimit: 20,
  },
};
```

`aggregateBy` is the trap. `@netlify/functions` types it as `RateLimitAggregator | RateLimitAggregator[]`, so `"ip"` and `["ip"]` both type-check and build. The platform requires both keys, rejects anything else, and discards **every** rate-limit rule on the site when it does.

## 4. How to prove the limit is active

Two checks, both needed:

- **The deploy log.** Search it for `rate limiting rule`. A rejected rule appears only there, as:
  `Invalid programmatic custom rate limiting rule: aggregate keys must include both ["domain", "ip"], found [domain]. Ignoring all rules.`
  The deploy still succeeds, and the endpoint runs unprotected
- **The burst from step 6.** `windowLimit + 1` empty POSTs from an allowed Origin inside the window: 400s, then a 429. Because the edge refuses before the function runs, none of them costs a model call either way

## Guardrails at the proxy

**Status: the core is verified with the skill's scripted tests** (`agent-guardrails.test.ts`, a scripted model, a policy source changed between requests). The adapter below type-checks against `@netlify/functions` and `@netlify/blobs`, but is not yet confirmed on a live deploy: the Blobs CLI commands, and a change applying on the next request, are to check on the first site that uses it.

**Where the policy lives:** Netlify Blobs, store `agent-guardrails`, key `policy`. A function reads it on each request, so a change applies to the next one with no deploy. `AGENT_GUARDRAILS` (an environment variable) is the fallback; Netlify applies a changed variable to functions only on the next deploy.

```sh
netlify blobs:set agent-guardrails policy --input guardrails.json   # change it: no deploy
netlify blobs:get agent-guardrails policy                           # check it
netlify env:set AGENT_CONVERSATION_SECRET "$(openssl rand -base64 48)" --secret
```

**The client IP** is `context.ip`, from the function's second argument.

```ts
// netlify/functions/agent/agent.mts, with guardrails
import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import { answerTurn } from "./agent-core";
import { envSource, proxyGuardrails, type PolicySource } from "./agent-guardrails";

const ALLOWED_ORIGINS = ["https://example.com", "http://localhost:3000", "http://localhost:8888"];

/** The policy in Netlify Blobs: change it with `netlify blobs:set`, no deploy. */
const blobs: PolicySource = () => getStore("agent-guardrails").get("policy");

// Module scope, so counts outlive a request (per instance; the edge rate limit below stays the outer bound).
const guardrails = proxyGuardrails({
  sources: [blobs, envSource("AGENT_GUARDRAILS")],
  secret: process.env.AGENT_CONVERSATION_SECRET,
});

export default (req: Request, context: Context) =>
  answerTurn(req, { anthropic: new Anthropic(), allowedOrigins: ALLOWED_ORIGINS, guardrails, client: context.ip });

export const config: Config = {
  path: "/api/agent",
  // GET serves the policy copy the page reads (guardrails-src="/api/agent").
  method: ["GET", "POST"],
  rateLimit: { action: "rate_limit", aggregateBy: ["domain", "ip"], windowSize: 60, windowLimit: 20 },
};
```

Add `@netlify/blobs` and `@nxisai/agent-harness` (0.14.0 or later) to the project's dependencies. The edge `rateLimit` counts GETs too; the page fetches the copy once per load and revalidates it with its ETag, so 20 a minute is still ample.

**Prove it** after the deploy, as step G3 says, then once more after a `netlify blobs:set` that lowers `input.maxLength`: the next over-length request is a 413 with no deploy in between.

## Also on Netlify

- A spending ceiling: set a credit limit on the Netlify account, which covers AI Gateway usage
- Secret scanning: Netlify scans builds for values that look like secrets. The core and adapter contain none; if a build is flagged, the site tag token is the usual suspect, and it is public by design — say so rather than rotating it
