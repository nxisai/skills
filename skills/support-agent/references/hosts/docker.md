# Docker

**Status: draft. Verified locally, never deployed.** The image was built from [`docker/`](docker/) and run on one machine, with the real `@anthropic-ai/sdk` pointed at a stand-in for the Messages API (`SUPPORT_MODEL_BASE_URL`) and stub MCP servers for the site and for provisioning. These were checked: the image runs as `node` and reports healthy, both cards point at `PUBLIC_ORIGIN`, `/healthz` says `{"available":true}` without the token and the setup with it, 403 without the token, 413 over 64 KB, a not-found turn whose gap report reached the stub provisioning server with its `ref`, the turn kept in `/data/turns.jsonl` on the volume (mode 600, owned by `node`) under the same ref Node computes, `docker stop` during a turn (the turn finished, its report went, exit 0), `docker stop` with a report still out after the response (it went before exit), and no token, key or question in the logs. The in-process tests (`hosts/hosts.test.ts`) cover the same routes and the shutdown. Not run: a real model key, a real site MCP server or provisioning server from the container, a reverse proxy, TLS. Tell the user it is a draft.

Detect: a `Dockerfile` or `compose.yaml` in the project, a site on a static host whose owner runs a server or VM, or a user who wants the agent as a service of their own. With `gcloud run` in its scripts, a `cloudbuild.yaml` or a Cloud Run `service.yaml`, use [cloudrun](cloudrun.md) instead: the same image, a different store.

| Question | Docker |
|---|---|
| Server code | `docker/server.ts` on `node:http` (`docker/node-server.ts`), bundled into the image. No framework, no new dependencies. Locally: `docker compose up` |
| Tasks and context | Memory: the SDK's `InMemoryTaskStore` and the core's `memoryContext()`. **One replica** |
| Questions and turns | `fileTurns` from example-site.ts, a JSON Lines file at `/data/turns.jsonl`, on a named volume: a gap question's wording under its key, a reported turn under its ref. NxisAI gets the key and the ref, never the words |
| Secrets | `.env.local` (gitignored) through `env_file`, or a Docker secret through `<NAME>_FILE` |
| Response time | No limit. The response is held open until the turn's gap reports have settled (at most `SUPPORT_REPORT_WAIT_MS`, 5 s) |

## 1. Where server code lives

A directory of its own, with its own build context:

```
support-agent/
  Dockerfile        ← docker/Dockerfile
  compose.yaml      ← docker/compose.yaml: one replica, the turns volume
  .dockerignore     ← keeps .env* out of the build context
  .env.example      ← committed, names only
  .env.local        ← gitignored: the values
  package.json      ← docker/package.json: @a2a-js/sdk, @anthropic-ai/sdk
  server.ts         ← docker/server.ts, imports './node-server', './support-core', './site'
  node-server.ts    ← docker/node-server.ts, imports './support-core'
  support-core.ts   ← unchanged
  site.ts           ← the SupportSite (from example-site.ts)
```

The Dockerfile has two stages. The first bundles the TypeScript with esbuild into one `server.mjs`, packages external. The second is `node:22-alpine` with the runtime dependencies only (about 190 MB), runs as `USER node`, and has a `HEALTHCHECK` on `/healthz` with the `wget` already in the image. `node` is PID 1, not `npm start`, so `SIGTERM` reaches the server. No `ARG` or `ENV` carries a secret. Commit a lockfile and use `npm ci` in the project; the reference ships none.

| Path | |
|---|---|
| `POST /a2a/support` | The A2A endpoint, relay only. The token is compared in constant time **before the body is read**; the body is capped at 64 KB **while it streams** |
| `GET /a2a/support/agent-card.json` | The card, built from `PUBLIC_ORIGIN`, never the `Host` header |
| `GET /.well-known/agent-card.json` | The same card. `SUPPORT_CARD_WELL_KNOWN=false` if another agent on the site claims it |
| `GET /a2a/support/healthz`, `GET /healthz` | `{ "available": … }`; with the relay token, also the model, the store, and whether gap reports (`gaps`), thumbs-up counts (`helpful`) and turn references are on. Never route `/healthz` publicly |

**Publish the port on loopback only** (`127.0.0.1:4130:4130`, as in `compose.yaml`). The site's reverse proxy routes `/a2a/support`, `/a2a/support/agent-card.json` and, if nothing else claims it, `/.well-known/agent-card.json` to the container. The relay calls `http://127.0.0.1:4130/a2a/support` (or `http://support-agent:4130/a2a/support` from the same compose project) with the token, and reads `availability` from `/healthz` with a one-second timeout. The quote-agent skill's `hosts/docker.md` has the Caddy route and the relay target written out; only the paths and the port differ.

## 2. Tasks and context: memory, one replica

A conversation's context (the last exchanges, the business in scope, an offer of a person, the last 20 answers for their 👍/👎, the gap one-shot flags) lives in the process that served its first turn. A restart loses the conversations in flight: the next message gets "please ask again", and thumbs on old answers do nothing. Nothing else is lost; the agent sends nothing a restart could duplicate.

**What breaks with more than one replica**, behind any balancer: a follow-up landing on the other replica finds no task (`Task not found`) or no context, a "yes" to an offer of a person is read as a new question, and a 👎 on an answer the other replica gave is ignored. Two replicas appending to one turns file on a shared volume would also interleave writes. For more than one, keep tasks, context and turns in a shared store: the cloudrun profile's `firestore-store.ts` works from any host with Google credentials, or write a `TaskStore` and `ContextStore` over the database the site already has (the quote-agent skill's `hosts/docker/redis-store.ts` is one shape). A follow-up must read what the turn before it wrote, so the store must be strongly consistent.

## 3. Questions and turns, on the volume

With `SUPPORT_TURN_REF_SECRET` set, each gap question's wording and each reported turn is appended to `/data/turns.jsonl` before its report goes; the report carries only their keyed hashes. Without the secret no gap or close report is sent (👍 counts still are): the start-up line says so. The Dockerfile makes `/data` (owned by `node`, mode 700) and sets `SUPPORT_TURN_STORE` there; `compose.yaml` mounts the `support-turns` volume on it, so they survive a rebuild. The owner looks a gap's key and refs up with

```sh
docker compose exec support-agent grep '"key":"<question_key>"' /data/turns.jsonl   # the question's wording
docker compose exec support-agent grep '"ref":"<ref>"' /data/turns.jsonl            # the turn: prompt and reply
```

The file has no retention of its own. Delete lines older than what the owner agreed (step 3), for example from a cron on the host, and delete the volume with the visitor's other data.

## 4. Secrets

`env_file: ./.env.local`, gitignored, with `.env.example` committed with names only. On a server, the same file outside the repository with owner-only permissions, or a Docker secret: every secret can be read from the file `<NAME>_FILE` names (`A2A_RELAY_TOKEN_FILE=/run/secrets/relay_token`). Settings are read once, at startup; a missing one names itself and the process exits.

| Variable | |
|---|---|
| `A2A_RELAY_TOKEN` | Secret. Required, 32+ characters (`openssl rand -hex 32`); the relay's target sends the same value |
| `ANTHROPIC_API_KEY` | Secret. Unset (and no `SUPPORT_MODEL_BASE_URL`): no model, `available: false` |
| `SUPPORT_GAP_KEY` | Secret. The site-scoped key, piped from `nxis keys create --scope content_gaps:report … --json` straight into the file, never printed |
| `SUPPORT_TURN_REF_SECRET` | Secret, 32+ characters. Question keys and turn references. Unset: no gap or close reports |
| `PUBLIC_ORIGIN`, `SUPPORT_MCP_ENDPOINT` | Required. The site's origin; its MCP server |
| `SUPPORT_PROVISIONING_ENDPOINT` | With the gap key: where reports go |
| `SUPPORT_MODEL`, `SUPPORT_REWRITE_MODEL`, `SUPPORT_MODEL_BASE_URL` | As in SKILL.md step 3 |
| `SUPPORT_REPORT_WAIT_MS`, `SUPPORT_SHUTDOWN_MS` | Default 5000 and 8000 (12000 in `compose.yaml`, with `stop_grace_period: 15s`) |

The ways to leak a key are a container's usual ones: `ARG`/`ENV` in the Dockerfile (`docker history` prints them), `environment:` in compose (`docker compose config` prints it), and error bodies. The `.dockerignore` keeps `.env*` out of the build context. Set a budget on the API key at Anthropic.

## 5. Gap reports, and stopping

The core sends a turn's gap report after the reply. The server holds that request's response open until its reports have settled, at most `SUPPORT_REPORT_WAIT_MS`: every event of the reply has already been written, so the visitor waits for nothing, and only the stream's end comes later (by the provisioning server's answer time, about 1.5 s with the stub). Each response waits for its own turn's reports only.

On `SIGTERM` (`docker stop`, a deploy) the server stops taking connections, lets the requests in flight finish (each held for its reports), waits for any report still out (`executor.settled()`), and exits, all within `SUPPORT_SHUTDOWN_MS`. Keep `stop_grace_period` above it, or Docker's SIGKILL at 10 s cuts it short. A report that hasn't gone by then is lost; nothing else is.

## How to prove it

```bash
docker compose up -d --build
curl -s http://127.0.0.1:4130/healthz                                  # {"available":true}
curl -s -H "Authorization: Bearer $A2A_RELAY_TOKEN" http://127.0.0.1:4130/healthz   # the model, "store":"memory", gaps, turnRefs
curl -s http://127.0.0.1:4130/a2a/support/agent-card.json              # the card, pointing at PUBLIC_ORIGIN
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' http://127.0.0.1:4130/a2a/support   # 403
head -c 100000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $A2A_RELAY_TOKEN" --data-binary @- http://127.0.0.1:4130/a2a/support   # 413
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q support-agent)"       # healthy
```

Then SKILL.md step 7 through the relay. Ask one unanswerable question and `docker compose stop` straight after: the logs end with the `SIGTERM` line and the report is on the gap list. Then

```bash
docker compose logs support-agent | grep -ciE 'sk-ant|bearer '   # → 0
```
