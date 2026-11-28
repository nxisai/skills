# Docker

**Status: verified locally; deployment is a draft.** The container, the Redis limiter, the restart proof and the fallback when Redis is down have been built and run on one machine. NxisAI's model bench runs on this profile. Serving it to a live site, behind TLS, has not been run end to end. Tell the user which parts are a draft, and confirm each item marked **Unconfirmed** before relying on it.

Detect: a `Dockerfile` or `compose.yaml`/`docker-compose.yml` in the project, or a user who wants the endpoint to run as a service of their own rather than on a platform.

Docker is the profile for a proxy that is **its own service** rather than a function on the site's host:

- A site on a static host, whose owner runs a server or VM of their own
- One endpoint shared by several sites
- A model that runs on the user's own hardware (Ollama or similar), alongside or instead of a vendor
- A model chosen per request, from an allowlist
- A test rig, which is how this profile was first built

It is also the only profile where the local runtime and the deployed artifact are the same image, which collapses steps 5 and 6 into one command.

## 1. Where server code lives, and what it runs on locally

A directory of its own, beside the site rather than inside it:

```
model-proxy/
  Dockerfile
  compose.yaml
  package.json
  server.mjs       ← the adapter: node:http, no framework
  limit.mjs        ← the limiter, which this host has to supply itself
  registry.mjs     ← the model allowlist, if routing between models
  adapters/        ← one file per vendor
```

`node:22-alpine`, `CMD ["node", "server.mjs"]`. There is no platform request object: the handler is `createServer((req, res) => …)`, so the adapter reads `req.headers.origin` and writes with `res.writeHead`. Cap the body's size **while streaming** rather than after buffering, or a large body costs memory before it is refused.

**Publish the port on loopback only**, locally and on a server:

```yaml
ports:
  - 127.0.0.1:4100:4100   # never 0.0.0.0
```

The container holds model credentials and has no authentication beyond an origin check. Bound to `0.0.0.0`, it is a metered endpoint published to the network. On a server, traffic reaches it through a reverse proxy that terminates TLS, never directly.

**How the page reaches it.** Pick one shape:

- **Same origin (prefer this).** The site's reverse proxy routes `/api/agent` to the container, so the page calls its own origin. This keeps the main skill's same-origin rule, needs no CORS, and `createProxyProvider` keeps its default `endpoint: '/api/agent'`. Run locally behind a dev server's proxy (Vite's `server.proxy` with `changeOrigin: false` and `xfwd: true`): the browser's `Origin` reaches the container unchanged, since `changeOrigin` only rewrites `Host`. **Unconfirmed:** not yet run behind a live site's reverse proxy.

  ```
  # Caddy, on the site's host
  example.com {
    handle /api/agent { reverse_proxy 127.0.0.1:4100 }
    handle { root * /srv/site; file_server }
  }
  ```

- **Its own origin** (`agent.example.com`). This is for a site whose host cannot route a path to it. Here the Origin allowlist is the boundary, so the adapter must answer the browser's preflight with the same decision as the real request:
  - `OPTIONS` from an allowed origin gets a 204 with `Access-Control-Allow-Origin` set to that origin, `Access-Control-Allow-Methods: POST, OPTIONS` and `Access-Control-Allow-Headers: Content-Type`.
  - Any other origin gets a 403.
  - The real response carries the same `Access-Control-Allow-Origin` and `Vary: Origin`.

  Point the page at the full URL: `createProxyProvider({ endpoint: 'https://agent.example.com/api/agent' })`. **Unconfirmed:** the preflight code has been run, but not yet from a real page on another origin.

`ALLOWED_ORIGINS` is an environment variable rather than a constant, because the same image serves different origins locally and when deployed. A page reached through a tunnel sends the **tunnel's** origin, not `localhost`'s, so a tunneled test needs that host in the list too.

## 2. Where the model credential comes from

Locally, use `env_file` pointing at a gitignored file:

```yaml
env_file:
  - ./.env.local      # gitignored; .env.example is committed with blank values
```

On a server, use the same file kept outside the repository with owner-only permissions, or a Docker secret, which arrives as a file under `/run/secrets/` that the adapter reads at startup. **Unconfirmed:** the Docker secret path has not been run with this adapter.

Commit `.env.example` with empty values, so the variable names are discoverable without the values.

Three ways to leak the key here:

- **`ARG`/`ENV` in the Dockerfile.** Build arguments persist in the image history, and `docker history` prints them. The key arrives at runtime, never at build time.
- **`environment:` in compose.** Anyone who can read the repo can read the key, and `docker compose config` prints it.
- **Error bodies.** A vendor's message can carry request detail, so log it and return your own line.

Read the environment once at startup. A missing key should fail at that point, naming the variable, not at the first request as a vendor 401.

There is no platform account to cap spending, so set a ceiling at the vendor: a budget on the API key, or a key scoped to one project.

## 3. The rate-limit primitive

**This is the one question Docker does not answer for you.** Netlify and Cloudflare both hand the limit to the platform, which refuses at the edge before any code runs. A container has no edge, so the cheapest refusal available is inside the process. But a counter inside the process is lost on restart and not shared between replicas, which turns a limit into a suggestion.

So the primitive is Redis `INCR` + `EXPIRE` on a sidecar:

```js
const n = await redis.incr(`rl:${key}`);
// Only the first request in a window sets the expiry. Setting it every time
// slides the window forward and the budget never resets.
if (n === 1) await redis.expire(`rl:${key}`, WINDOW);
if (n > LIMIT) return refuse(429, await redis.ttl(`rl:${key}`));
```

Four things that bite:

- **`EXPIRE` on every request** is the common bug. It slides the window, so the budget never resets and a steady caller is refused forever.
- **The `redis` client retries a failed connection indefinitely.** So `connect()` never rejects, and the first request *hangs* instead of falling back. Set `socket: { connectTimeout: 1000, reconnectStrategy: false }` and race the connect against your own timeout. This was measured, not assumed: the unfixed version ran a request into curl's timeout; the fixed one answered in 15 ms.
- **The key behind a reverse proxy.** Behind one, every request arrives from the reverse proxy's address, so a limit keyed on the socket address is one bucket for all visitors. Key on the client address from `X-Forwarded-For`, but only behind a flag (`TRUST_PROXY=true`), only when the container is reachable from the reverse proxy alone, and only if the reverse proxy *replaces* the header rather than appending to it. Trusted unconditionally, the header is a one-line bypass: the caller picks its own bucket. **Unconfirmed:** the flag has been run, but not behind a live reverse proxy.
- **Redis itself.** Don't publish its port, and give it a password on any network the proxy shares with other services. Replicas of the proxy share one Redis; that sharing is the reason it is there.

Keep an in-process counter as the fallback, log which limiter is live, and let the proxy degrade rather than die when Redis goes away.

## 4. How to prove the limit is active

Three checks. The second distinguishes a real limiter from the fallback, and no platform host needs it. Run all three locally, then again on the server against the public URL:

```bash
# 1 — the budget is enforced, with Retry-After
for i in $(seq 1 8); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST \
    -H 'Origin: https://example.com' -H 'Content-Type: application/json' \
    -d '{}' https://example.com/api/agent
done                      # with a limit of 4 → 400 400 400 400 429 429 429 429

# 2 — it survives a restart, so the budget is in Redis and not in memory.
#     `restart`, not `up`: compose up starts depends_on services, which would
#     bring Redis back and void the test.
docker compose restart model-proxy   # then repeat → still 429

# 3 — no key material in the logs
docker compose logs model-proxy | grep -iE 'sk-ant|sk-|api[_-]?key=|AIza'   # → nothing
```

Check the order of refusals too. A request from an origin not on the allowlist must come back 403 **without** consuming budget: the origin check is free and the budget is not. Behind a reverse proxy, also send the burst from two machines. They should get separate budgets; if they share one, the limiter is keyed on the reverse proxy's address.

## Guardrails at the proxy

**Status: verified locally; deployment is a draft.** Run in this container on one machine (Docker Desktop on macOS), with the page's dev server routing `/api/agent` to it: the policy copy on `GET` (no `systemPrompt`, `ETag`, `304`), `413` with `Nxis-Guardrail: input/length`, `403` for a denied tool, a policy edit applied on the next request with no restart, both lockdowns (`503`), the counts in Redis, and the skill's scripted tests in the container's project. Not yet run behind a live site's reverse proxy.

The container's `server.mjs` speaks `node:http`. To use `agent-core.ts` and `agent-guardrails.ts`, build the core with the project's bundler (or run it with a TypeScript loader) and hand it a Web `Request`, which Node 22 has: `new Request(url, { method, headers, body, signal })` from the incoming request, then write the `Response`'s status, headers and body back. Bundling with esbuild (`esbuild server.mjs --bundle --platform=node --format=esm --packages=external --outfile=dist/server.mjs`) in a build stage keeps `CMD ["node", "server.mjs"]` in the runtime stage.

Two things the adapter has to carry across, or the guardrails quietly lose half their contract:

- **In:** `Origin`, `Content-Type`, `Accept`, `Nxis-Conversation`, `Nxis-Guardrails-Version` and `If-None-Match` from the incoming request. Without `Nxis-Conversation` every request starts a new conversation, and the per-conversation limits count by IP and origin only.
- **Out:** every header the `Response` set, not just its content type: `ETag` and `Cache-Control` on the copy, `Nxis-Conversation`, `Nxis-Guardrails-Version` and `Nxis-Guardrail` on a turn. An adapter that writes back only `content-type` (as one without guardrails can) drops all of them, and the page never learns its conversation id or that the policy changed.

Answer `GET` on the agent path before the Origin check and the rate limit: the copy isn't secret, and `answerTurn` serves it.

A container that calls `answerTurn` passes the guardrails from `makeGuardrails` below, always: with no policy file they run the built-in defaults. The `server.mjs` of section 1, which doesn't use the core, has none of these; its limiter and caps are all that stand in front of the model, so a container serving a live site should use the core.

**Where the policy lives:** a file in a directory mounted read-only (`./policy:/run/config:ro`, with the policy at `./policy/guardrails.json`). It is read on each request, so editing it on the host applies to the next one, with no restart and no rebuild.

Mount the **directory**, not the file. Most editors, and `sed -i`, save by writing a new file and renaming it over the old one. A single-file bind mount keeps the old inode, so after the first such save the file is gone inside the container, the source reads no policy, and every request runs with no guardrails at all. This was measured: after one `sed -i` save, `/run/config/guardrails.json` no longer existed in the container and an over-length message reached the model.

Even with the directory mounted, a rename-style save can leave a moment when the file reads as missing inside the container. In 60 saves, each followed at once by an over-length request, the read failed with `ENOENT` 5 times. A source that answers a missing file with "no policy" turns every guardrail off for those requests. So the file source never does: a failed read returns the last policy it read, and with none yet it throws, which makes the built-in defaults apply. With no file configured at all there is no policy, and the built-in defaults apply.

```ts
import { readFile } from "node:fs/promises";
import { proxyGuardrails, type CountStore, type Counts, type PolicySource } from "./agent-guardrails";

/**
 * A policy in a file the deployment says is there. A failed read, missing file included, never means "no policy":
 * it returns the last policy read, and with none yet it throws, so the built-in defaults apply.
 */
const fileSource = (path: string): PolicySource => {
  let last: string | null = null;
  return async () => {
    try {
      return (last = await readFile(path, "utf8"));
    } catch (error) {
      console.warn(`[agent] guardrails policy ${path} unreadable (${(error as NodeJS.ErrnoException).code})`);
      if (last) return last;
      throw error;
    }
  };
};

/** Counts in the Redis sidecar the limiter already uses, so they survive a restart and are shared by replicas. */
const redisStore = (redis: {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, o: { PX: number }): Promise<unknown>;
}): CountStore => ({
  get: async (key) => {
    const raw = await redis.get(`gr:${key}`);
    return raw ? (JSON.parse(raw) as Counts) : undefined;
  },
  set: async (key, counts, ttlMs) => void (await redis.set(`gr:${key}`, JSON.stringify(counts), { PX: ttlMs })),
});

/** With AGENT_GUARDRAILS_FILE unset there is no policy, and the built-in defaults apply. */
export const makeGuardrails = (redis: Parameters<typeof redisStore>[0]) =>
  proxyGuardrails({
    sources: process.env.AGENT_GUARDRAILS_FILE ? [fileSource(process.env.AGENT_GUARDRAILS_FILE)] : [],
    secret: process.env.AGENT_CONVERSATION_SECRET,
    store: redisStore(redis),
  });
```

Set `AGENT_GUARDRAILS_FILE: /run/config/guardrails.json` in compose's `environment:` (it isn't secret), and `AGENT_CONVERSATION_SECRET` in the `env_file` beside the key.

**The client IP** is the same key the limiter uses: the socket address, or `X-Forwarded-For` behind `TRUST_PROXY=true` as section 3 says. On its own origin, add `Nxis-Conversation` and `Nxis-Guardrails-Version` to `Access-Control-Allow-Headers`, and expose `Nxis-Conversation`, `Nxis-Guardrails-Version` and `Nxis-Guardrail` with `Access-Control-Expose-Headers`; allow `GET` for the policy copy.

The Redis store reads and writes without a transaction, so two requests of one conversation at the same instant can both pass a limit they share. **Unconfirmed:** whether that matters for a site; a Lua script makes it atomic if it does.

## Also on Docker

- **Healthcheck.** `wget -qO- http://localhost:PORT/healthz` is already in `node:*-alpine`, so the check needs no extra layer. Report the configured budget and the known models from it, so a proxy whose registry is wrong says so before a request is made. Don't route `/healthz` through the public reverse proxy unless you mean to publish what it reports.
- **`depends_on: condition: service_healthy`** on anything the proxy needs at startup, Redis included. Without it, the proxy races its dependency and crash-loops on the first request.
- **`restart: unless-stopped`.** The container is the endpoint; a crash should not take the site's agent down until someone notices.
- **Transcripts are off by default.** A proxy can record every request and response, which is what a test rig wants. On a live site, that record holds visitors' words. Turn it on deliberately, mount the directory out of the container so it outlives it, and treat any id that arrives on a header as untrusted before it becomes part of a path.
