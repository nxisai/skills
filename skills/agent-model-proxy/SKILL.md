---
name: agent-model-proxy
display_name: Agent Model Proxy
icon: server-stack
source: NXISAI
description: >
  Run an on-page agent's model behind server code on the site's own host,
  using the agent-harness proxy contract, with origin, rate and size limits
  and a credential the browser never sees. Use when adding createProxyProvider
  to a site, on any host that runs server code.
license: Apache-2.0
compatibility: >
  Any host that runs server code. Profiles: netlify (verified); vercel and
  cloudflare (draft). Other hosts: asks four questions.
metadata:
  author: nxisai
  version: 1.1
  type_group: _integration
allowed_tools: []
enabled: true
---

Write the server half of `createProxyProvider`: one endpoint on the site's own origin that takes a turn from the page's agent, asks the model for the next one, and answers in the shape the harness reads — holding the model credential where no visitor can see it, and refusing anything it should not pay for before it pays.

The harness writes the client. This skill writes the endpoint. What passes between them is a small contract, and every rule in it is silent when broken.

## When this skill applies

Use this skill when **all** of the following are true:

- The site is getting an on-page agent from `@nxisai/agent-harness`, and its model will run remotely rather than in the tab — normally decided in **on-page-agent**
- The site's host can run server code: a function, a route handler, a worker
- You are running in the project that builds the site, and the user can deploy it

Do not use this skill for:

- Choosing whether the model runs remotely at all. That is **on-page-agent**, which calls this skill once the answer is yes
- A site whose host serves static files only. There is nowhere for the credential to live; **on-page-agent** can run the model on-device instead
- Calling a model from the browser with a key in the page. That is what this skill exists to prevent

## The contract

The harness POSTs to the endpoint with `Accept: application/json` and this body:

```ts
{
  messages: { role: "system" | "user" | "assistant", content: string }[], // system prompt included
  tools: { name: string, description?: string, inputSchema?: object }[],   // this agent's slice only
  maxTokens?: number,
  cache?: { stableMessages: number, toolsStable: boolean }
}
```

It reads back:

```ts
{
  text: string,                           // rendered verbatim
  call?: { name: string, args: object },  // at most one
  usage?: { promptTokens: number, outputTokens: number }
}
```

A non-2xx response with `{ error }` is shown to the visitor as the agent's failure line. With guardrails at the proxy, a refusal also carries `refusal: { stage, rule, action, severity }`, which the harness (0.14.0 and later) shows with the same message and `nxis-guardrail` event as its own decision; see [Guardrails at the proxy](#guardrails-at-the-proxy-optional). Five rules, none of which anything enforces for you:

- **`text` is rendered verbatim.** Strip anything that is not for a person to read
- **At most one `call` per turn.** The harness runs one tool a turn; the client takes the first and warns about the rest
- **Honor the abort.** The client passes the turn's abort signal to `fetch`. Pass the request's signal on to the model call, so a visitor pressing stop stops the spend
- **Answer with JSON while the request asks for it.** A later streaming client will ask for `text/event-stream`, and an endpoint that only speaks JSON keeps working with this one
- **The cache hint is advice.** `{ stableMessages, toolsStable }` says what repeats next turn. Acting on it — prompt caching, where the model vendor offers it — is optional

## The host

Everything about the endpoint is the same on every host except four things. Answer them from `references/hosts/<host>.md` when one exists for the project's host, and ask the user when none does:

| Question | Why it matters |
|---|---|
| Where does server code live, and what does it run on locally? | Where the adapter goes, and the local origin the Origin list must allow |
| Where does the model credential come from? | A host gateway or secret store. Never a public environment variable |
| What is the rate-limit primitive? | The one defense that has to be the host's own, so a refused request costs nothing |
| How do I prove the limit is active? | Some hosts accept a rule and quietly do not enforce it |

Profiles: [netlify](references/hosts/netlify.md) is verified in production. [docker](references/hosts/docker.md) is verified locally, and its deployment is a draft. [vercel](references/hosts/vercel.md) and [cloudflare](references/hosts/cloudflare.md) are drafts — each says which of its answers are unconfirmed. When you use a draft, tell the user, and confirm those answers against the host's own documentation as you go.

The platform hosts supply the rate limit and the way to prove it; **Docker does not**. There is no edge to refuse at, so the limiter is something you build, and proving it means showing it survives a restart. Reach for Docker when the endpoint is a service of its own rather than a function on the site's host: a site on a static host whose owner runs a server, one endpoint shared by several sites, a model on the user's own hardware, or a model chosen per request. It is the user's infrastructure, so offer it; don't choose it for them.

## The pattern, in six steps

### Step 1 — Identify the host, and confirm it runs server code

Find the host from the project (`netlify.toml`, `vercel.json`, `wrangler.toml`, a `Dockerfile` or `compose.yaml`), then load its profile. With no profile, ask the user the four questions above.

If the host serves static files only, stop and hand back to **on-page-agent**. Do not reach for a third-party function service to hold the key without the user choosing it; that is a new vendor, and their decision.

### Step 2 — Get consent to a metered, public endpoint

This endpoint spends money on every turn, from a URL anyone can call. Say both, and **wait for an explicit yes:**

- Each visitor turn is a model call, billed to the user's account with the host or the model vendor
- The endpoint is public by nature — the page has to be able to reach it — so the defenses in step 4 are what stand between it and a script
- Recommend a spending ceiling, wherever the host or the vendor offers one, before the first deploy. It is the one layer that holds when every other one is wrong

Consent to an agent on the page is not consent to this. Ask for it here.

### Step 3 — Write the endpoint

Two files: a host-neutral core, and an adapter from the host profile that calls it. The core is standard `Request` in, `Response` out, which every host in the profiles runs.

The core is [`references/agent-core.ts`](references/agent-core.ts): copy it into the project unchanged. It checks the Origin, the body size, the message count and length, and the token ceiling (`LIMITS`), maps the request to the model's API, honors the abort, and answers in the contract's shape. Logged upstream errors are never returned. With guardrails (below) it also takes `guardrails` and `client`; without them it behaves exactly as it always has.

The endpoint's path is the one the page will use — `/api/agent` unless the project already has a convention. It must be on the site's own origin: same origin is what lets the Origin check mean something, and it is where `createProxyProvider` is pointed. On Docker, that means the site's reverse proxy routes the path to the container. Where it can't, the profile describes the alternative: the container on its own origin, answering CORS, with the Origin allowlist as the boundary.

**The credential** comes from the host profile: a gateway the host injects, or a secret in the host's store. Never from an environment variable with a public prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`), and never from a file in the repository. If the host injects it through a gateway, do not also set the key yourself — on some hosts a variable you set wins over the gateway's, silently.

**The model** is the one constant. Use the current default unless the host's gateway does not serve it, in which case the newest one it does.

Add `@anthropic-ai/sdk` to the project's dependencies if it is not there.

### Step 4 — Defend it, cheapest refusal first

Four layers, in this order, because each one is cheaper to pass through than the one behind it:

1. **Origin allowlist** — in the core. List full origins, scheme and port included, exactly as a browser sends them in the `Origin` header: the production origin, and each local origin the site is run on. This is stricter than the site tag token, which lists bare hosts and ignores ports — so the rule is that **every origin here has a host the token allows**. A mismatch means one half of the agent works in a place where the other does not
2. **Rate limit per client** — the host's own primitive, from the profile. Twenty requests a minute per client allows a long conversation and refuses a script. Where the host enforces it before the code runs, a refused request never reaches the model at all
3. **Hard caps** — in the core. Body size, message count, message length and `max_tokens` are the endpoint's ceilings, not the caller's requests
4. **A spending ceiling** — on the account, from step 2. It holds when the other three are misconfigured

Log upstream errors; never return them. A provider's error message can carry detail the visitor has no business seeing.

### Step 5 — Test it on the host's local runtime

Run the site on the host's local runtime from the profile, so the endpoint and the page share an origin, then check:

| Request | Expect |
|---|---|
| POST from the local origin, a real `messages` array | 200, with `text` |
| POST with no `Origin` header | 403 |
| POST with a foreign `Origin` | 403 |
| POST from the local origin with `{}` | 400 |

On Docker the local runtime *is* the deployed artifact — the same image either way — so this step and step 6 are one `docker compose up`, and the only thing left for step 6 is the proof. Locally, the page and the container are on different ports, so different origins. The Origin allowlist and the preflight both run, whichever shape production uses.

Check the page too: the harness's header badge should read **Remote**. If the site tag is installed and its token allows `localhost`, the page's tools arrive in the request's `tools` array — one real turn that calls a tool is the whole chain working.

### Step 6 — Deploy, then prove the limit is enforced

Tell the user to deploy. Once it is live, repeat the Origin checks from step 5 against the production origin, then **prove the rate limit is enforced rather than configured:**

- Send requests from the allowed Origin with an empty body, one more than the window's limit, inside the window. Each is a 400 until the limit trips, then a 429. The empty body means none of them reach the model, so the test costs nothing
- Then do what the profile says for this host. On some hosts a rejected rule shows up only in a build or deploy log, and the endpoint runs with no limit at all

A 400 on every request, with no 429, means the limit is not active. Stop and fix it before the site is announced — the endpoint is public and metered, and this is what stands in front of the meter.

## Guardrails at the proxy (optional)

The page's guardrails run in the visitor's browser, and a visitor who controls their browser can skip them. This endpoint is the one point on the agent's path the site controls and the visitor does not. With a **guardrails policy** configured, it enforces the guardrails too, on every request, and the site can change them without a deploy. With none configured, nothing here runs and the endpoint behaves exactly as before.

Offer this when the site cares that a script can't run up its bill or drive its tools past its rules, which is most sites with a remote model. It needs `@nxisai/agent-harness` 0.14.0 or later installed for the server code too (`npm i @nxisai/agent-harness`): the policy and its floors come from the harness, so the page and the proxy read the same document the same way.

**On-device models have no proxy**, so none of this applies to them. Say so if the site runs one.

### What the proxy enforces, and what stays in the browser

| At the proxy, on every request | Only in the browser |
|---|---|
| Input length (the newest message's own words, outside data blocks) | Approvals tied to a call, and every confirmation |
| Send rate per conversation, and per IP and origin | Link confirmation, and `link-origins` |
| Generations and output tokens per turn and per conversation | Screening of what the visitor typed, and of tool results |
| The declared tools: the policy's allow and deny lists; a reply may only call a tool the request declared | The tiers, which decide what the visitor confirms |
| The kill switch: `tools` (no tool may be declared) or `agent` (every call refused) | The page's own rules and classifier |
| The reply, on the model's stream: a canary the proxy puts in the prompt (new for every request) or a secret cuts it there, the model is stopped, and nothing of the reply is sent | Replies cut for length, the host's redaction patterns |

The proxy can't see the visitor's click, so it can't enforce a confirmation. It can, and does, refuse anything the policy doesn't allow before the model is paid for.

### Step G1 — The policy, where the host keeps it

The policy is a JSON document, versioned, documented in the harness (`docs/guardrails-policy.md`). Start from [`references/policy.example.json`](references/policy.example.json). It can only tighten: the harness's built-in defaults are the floor, and the checks that can't be turned off stay on.

Where it lives is the host's question, in its profile: the host's own store, which changes with no deploy (Netlify Blobs, Vercel Edge Config, a Cloudflare KV namespace, a mounted file for Docker), with an environment variable (`AGENT_GUARDRAILS`) as the simple fallback, which usually needs a redeploy to change. Sources are tried in order and the first that has a policy wins.

**If the policy can't be read** (the store is down, the JSON is malformed, a field has the wrong shape), the proxy logs it and enforces the built-in defaults. It never runs with no guardrails.

### Step G2 — Wire it into the adapter

[`references/agent-guardrails.ts`](references/agent-guardrails.ts) goes beside `agent-core.ts`. The adapter builds the guardrails **once, at module scope**, so counts outlive a request, and passes them with the client's IP:

```ts
import { proxyGuardrails, envSource } from "./agent-guardrails";

const guardrails = proxyGuardrails({
  sources: [/* the host's store, from its profile */ envSource("AGENT_GUARDRAILS")],
  secret: process.env.AGENT_CONVERSATION_SECRET, // 32+ characters, from the host's secret store
});

// in the handler:
answerTurn(req, { anthropic, allowedOrigins: ALLOWED_ORIGINS, guardrails, client: /* the host's client IP */ });
```

The endpoint also answers **GET** with the copy the page reads, so allow GET in the host's route config. The page points the element at it: `<nxis-agent guardrails-src="/api/agent">`.

**The conversation secret** signs a conversation id the proxy issues (`Nxis-Conversation`: an HMAC over the id, its expiry and the origin, good for an hour), which is what the per-conversation limits count by. Generate it once (`openssl rand -base64 48`) and keep it in the host's secret store, never in the repository. Without one, every limit is counted by IP and origin alone. A client that drops its id each time still meets the IP and origin limit: five conversations' worth of sends a minute.

**The model is streamed** when guardrails are on (`messages.stream`), and each delta screened as it arrives: the canary in the text or a tool call's arguments, however it is spaced or cased, and a secret in the text. A hit stops the model there, so the rest isn't paid for (what streamed counts against the budgets), and the endpoint answers with the refusal. The browser still gets one JSON answer, so nothing of a cut reply ever reaches it. `StreamScreen.safe()` is there for an endpoint that streams to the page: it holds back what could be the start of the canary.

**Counts** live in the instance's memory by default. On a serverless host each instance counts for itself, so the host's own rate limit, at its edge, stays the outer bound. That is why step 4's layer 2 still matters.

### A system prompt the proxy holds (optional)

Put the prompt in the policy's `systemPrompt`, and the proxy uses it for every request: whatever prompt a request carries is ignored, so a visitor who rewrites the page's prompt in their browser changes nothing. The proxy adds a data rule (the page's untrusted text arrives in `<data-…>` blocks) and its own canary. The copy served to the page never carries the prompt; it says `"prompt": "proxy"`, and the harness then sends no system prompt of its own.

Offer it when the prompt is worth keeping private, or must not be changed from the browser. It replaces every agent's prompt on the page, so a page with several agents (`agents`) that each have their own prompt should keep them in the page. The visitor's saved details, which the page puts in its system prompt, don't reach the model when the proxy holds the prompt; the page still fills forms from them. **On-device models have no proxy**, so a page that runs one keeps its own prompt.

### The contract, with guardrails

| | |
|---|---|
| `GET` the endpoint | The policy copy, without `systemPrompt`; `ETag`, `Cache-Control: no-cache`, `304` on `If-None-Match`. With no policy configured, the endpoint answers GET as before |
| Request `Nxis-Conversation` | The id the proxy issued, sent back. Optional |
| Request `Nxis-Guardrails-Version` | The policy version the page holds. Optional |
| Response `Nxis-Conversation` | A new id, when the request had none that was good |
| Response `Nxis-Guardrails-Version` | The current version, when it differs from the one the page sent |
| A refusal | `{ "error": "…", "refusal": { "stage", "rule", "action": "block", "severity" } }`, never with the visitor's text, and `Nxis-Guardrail: <rule>`. 413 `input/length`, 429 `input/rate` and `model/budget`, 403 `tool/not-listed`, 422 `tool/policy`, `output/canary` and `output/secret`, 503 `input/lockdown` and `tool/lockdown` |

An endpoint on another origin than the page must list those request headers in `Access-Control-Allow-Headers` and the response ones in `Access-Control-Expose-Headers`.

### Step G3 — Test it with a script, not a model

[`references/agent-guardrails.test.ts`](references/agent-guardrails.test.ts) plays a client that skips the browser's guardrails, against a scripted model, so it costs nothing: over-length input, over-rate sends (with and without its conversation id), an undeclared tool, a budget overrun, every call during a lockdown, a policy change taking effect on the next request, a broken policy falling back to the defaults, and no change at all with no policy. Run it in the project (vitest).

The same file also runs the real page side (`AgentHarness` with `createProxyProvider`) against the endpoint in-process: the proxy's lockdown and canary cut reach a page that knows nothing of them as the page's own message and `nxis-guardrail` event, and a prompt the proxy holds replaces the page's. And a short adversarial set: a deny pattern dodged by case, a lookalike name, a long message disguised as a tool result, a conversation id from another site.

Its type-check needs `dom.iterable` in the project's `lib` (it reads `Headers.keys()`).

Each host profile has a **Guardrails at the proxy** section: where the policy lives so it changes with no deploy, the secret, the client IP, and the adapter. Netlify's is the one to start from. Docker's is verified locally; Vercel and Cloudflare are drafts, with what is unconfirmed marked.

Then, on the host's local runtime: GET the endpoint and check the copy has no `systemPrompt`; send one message over the policy's `input.maxLength` with `curl` and check for `413` and `"rule":"input/length"`.

## Best practices

- Get consent to the spend before writing anything. The endpoint is a running cost from its first deploy
- Keep the core host-neutral and the adapter thin. Moving hosts, or adding one, then touches one small file
- Check every origin in the Origin list against the site tag token's hosts, and say so in a comment beside the list
- Put the host's rate limit where it refuses before the code runs, if the host offers that
- Prove the limit with a burst of empty requests. Configured is not enforced

## Anti-patterns

- A model key in the browser, or in a publicly prefixed environment variable
- Setting a key yourself on a host whose gateway injects one. It wins, and nothing says so
- Returning more than one tool call, or text the harness has to parse
- Dropping the request's abort signal. The visitor's stop button then stops nothing that costs money
- Returning upstream error messages to the visitor
- Taking the client's `maxTokens` as the limit rather than a request under it
- Reporting the endpoint protected because the rate-limit rule is in the code. The deploy decides that
- Standing up an endpoint for a host that cannot run server code by bringing in another vendor without asking

## Worked example

**Context:** **on-page-agent** has decided the model runs remotely. The project is a Next.js static export with a `netlify.toml`; the site tag's token allows the hosts `example.com` and `localhost`.

**Step 1.** Netlify: profile loaded. Functions live in `netlify/functions/` and run locally under `netlify dev` on 8888.

**Step 2.**

> Before I write this: every message a visitor sends your agent is a model call, billed through Netlify's AI Gateway to your Netlify account, from an endpoint anyone can reach. I'll limit it by origin, by rate per visitor and by size. I'd also set a credit ceiling on the Netlify account before the first deploy. Go ahead?

They agree.

**Step 3.** A function directory, `netlify/functions/agent/`, holding the adapter `agent.mts` and `agent-core.ts` beside it, path `/api/agent`. No key is set: the AI Gateway injects it.

**Step 4.** `ALLOWED_ORIGINS` is `https://example.com`, `http://localhost:3000` and `http://localhost:8888`, each on a host the token allows. `rateLimit` with `aggregateBy: ["domain", "ip"]`, 20 a minute.

**Step 5.** Under `netlify dev`: 200 from :8888, 403 with no Origin, 403 from a foreign one, 400 for `{}`. The badge reads Remote, and a turn that asks for a booking calls the booking tool.

**Step 6.** After the deploy: the same checks against example.com. Twenty-one empty POSTs: twenty 400s, then a 429. The deploy log has no rate-limit rejection.

> Your agent's model now runs behind /api/agent on example.com. It refuses other sites, caps each conversation, and cuts off any one visitor after 20 requests a minute. I tested that last part against the live site.

## Composing with other skills

This skill composes with:

- **on-page-agent** — calls this skill once it has decided the model runs remotely, then points `createProxyProvider` at the endpoint this skill writes
- **site-tag-installation** — its token lists the hosts; this endpoint lists full origins on those hosts
- **The host's own skills**, when the project has them installed — for functions, gateways, environment variables and deploys. This skill says what has to be true; they know the host's current way to do it

Hand back the endpoint path, the Origin list, and the result of the step 6 burst.

This skill owns **the endpoint and its defenses**. It does not choose whether the model runs remotely, mount the agent, or decide what the agent says.

## Tool reference

This skill calls no NxisAI tools. Its work is files in the project and requests to the site's own endpoint.

| File | Purpose |
|---|---|
| `agent-core.ts` | The contract and the in-code defenses. Host-neutral |
| `agent-guardrails.ts` | Optional: the guardrails policy, enforced on every request. Host-neutral |
| `agent-guardrails.test.ts` | Its tests, against a scripted model |
| `policy.example.json` | A policy to start from |
| The host adapter | Where the host runs server code, how it supplies the credential, and its rate limit — from `references/hosts/<host>.md` |
