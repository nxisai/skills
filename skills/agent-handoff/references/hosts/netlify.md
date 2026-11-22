# Netlify

**Status: verified.** The relay, the booking agent and the desk run on Copperline (`netlify/functions/handoff.mts`, `handoff-push.mts`, `a2a-booking.mts`, `a2a-desk.mts`, `desk-api.mts`), end to end in Chrome and in an in-process test of the harness against all three.

Detect: `netlify.toml` or `.netlify/` in the project.

## 1. Where server code lives, and what it runs on locally

Netlify Functions, in `netlify/functions/`. Every file directly in that directory is its own function, so the core goes in a function directory, or in a shared folder outside it:

```
netlify/functions/handoff/
  handoff.mts        ← the adapter: /api/handoff and /api/handoff/*
  handoff-core.ts    ← unchanged, from references/
netlify/functions/handoff-push.mts   ← the push path, its own function (question 4)
```

Locally, `netlify dev` serves the site and its functions on **`http://localhost:8888`**. Include that origin, and the framework's own dev origin, in `allowedOrigins`. `netlify dev --offline` runs without signing in, with a local Blobs sandbox.

## 2. Where records live

**Netlify Blobs**, with strong consistency — the relay writes a record on a visitor's first request and reads it on the next, possibly on another instance:

```ts
import { getStore } from "@netlify/blobs";

const blobs = () => getStore({ name: "handoff-relay", consistency: "strong" });
const store: RelayStore = {
  get: async (k) => ((await blobs().get(k, { type: "json" })) as never) ?? null,
  set: async (k, v) => void (await blobs().setJSON(k, v)),
  delete: async (k) => void (await blobs().delete(k)),
  list: async (p) => (await blobs().list({ prefix: p })).blobs.map((b) => b.key),
};
```

Add `@netlify/blobs` to the project's dependencies.

The local sandbox does not honor conditional writes (`onlyIfMatch`): it refuses every one. The relay core doesn't use them; a desk that does (Copperline's) must probe for support and fall back — see `netlify/lib/kv.ts` in Copperline.

## 3. Where secrets live

The site's environment variables, set in the Netlify UI or with `netlify env:set` — never in `netlify.toml`, which is in the repository, and never with a public prefix. A target's credential:

```ts
credential: () => ({ Authorization: `Bearer ${process.env.BOOKING_AGENT_TOKEN}` }),
```

For targets on the same site (Copperline's booking agent and desk), one shared `A2A_RELAY_TOKEN` that the relay sends and the targets check.

## 4. The rate-limit primitive, and how it is proved

`rateLimit` in the function's `config`, enforced at the edge:

```ts
export const config: Config = {
  path: ["/api/handoff", "/api/handoff/*"],
  method: ["GET", "POST"],
  rateLimit: { action: "rate_limit", aggregateBy: ["domain", "ip"], windowSize: 60, windowLimit: 60 },
};
```

`aggregateBy` must list both keys. The types accept `"ip"` alone; the platform then rejects the rule at deploy, logs it in the deploy log, and enforces no rate limit on the site at all.

The push handler is its **own function** with no rate limit, at `/api/handoff-push`. Pushes come from the targets' servers; under the visitor limit a busy desk trips it and follow-up emails stop.

Prove it after the deploy with 61 POSTs to `/api/handoff/nobody` from an allowed origin inside a minute: sixty 404s, then a 429. Then read the deploy log for a rejected rate-limit rule.

## 5. How long one response may stream

About ten seconds for a function's response, streamed or not, on the default plan. A desk's stream is budgeted under that (Copperline's closes after 8 s) and the harness picks it back up with `SubscribeToTask`. An agent target should answer each turn well inside it: Copperline's booking agent makes one model call per turn, 2–4 s.
