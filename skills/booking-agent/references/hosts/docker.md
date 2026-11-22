# Docker

**Status: verified locally against stubs; deployment is a draft.** The image was built and run on one machine (Docker Desktop, arm64) as two replicas sharing Redis, with the real `@anthropic-ai/sdk` pointed at a stub of the Messages API (`lambda/localstack/stubs.mjs model`) and a stub site serving free slots and taking bookings (`stubs.mjs sink`), driven over HTTP by `lambda/localstack/drive.mjs`. These were checked: both cards at `PUBLIC_ORIGIN`, 403 without or with a wrong token, 413 over 64 KB, a conversation from the calendar's offer through a pick, the details and the summary to one signed booking with the sink's reference, the summary on one replica and the yes on the other, the same yes on both replicas at once (one booking, both replies carrying the reference), Redis stopped (`/healthz` 503, `available: false`) and restarted (recovered by itself), no email, key or token in the logs, and the port on loopback only. Not run for the booking agent: Caddy in front, the relay core calling the container (the in-process tests run the relay against the same core), a real model key, and any deployment behind TLS. Where the sections below describe a check without saying so, it was the quote agent's run of this same server. Tell the user which parts are a draft, and confirm each item marked **Unconfirmed** before relying on it.

Detect: a `Dockerfile` or `compose.yaml` in the project, a site on a static host whose owner runs a server or VM, or a user who wants the agent to run as a service of their own.

Docker is the profile for a Booking Agent that is **its own service**, not a function on the site's host:

- A site on a static host, whose owner runs a server or VM of their own
- One Booking Agent for several sites: one image, one container per site, each with its own `.env.local`
- The same image locally and deployed: the local run *is* the deployed artifact

It answers the five host questions like this:

| Question | Docker |
|---|---|
| Server code | `server.ts` on `node:http`, bundled into the image. Locally: `docker compose up` |
| Tasks and progress | Memory, for one replica. Redis, for more than one (`compose.replicas.yaml`) |
| Conditional write | Redis `SET NX` on `<task>.<attempt>`, so only one replica ever books a given attempt |
| Secrets | `.env.local` (gitignored) through `env_file`, or a Docker secret through `<NAME>_FILE` |
| Response time | No limit. A replica stopped mid-turn leaves its task "working"; the next read fails it |

## 1. Where server code lives

A directory of its own, beside the site and with its own build context:

```
booking-agent/
  Dockerfile             ← hosts/docker/Dockerfile
  compose.yaml           ← one replica, memory
  compose.replicas.yaml  ← two replicas and Redis
  .dockerignore          ← keeps .env* out of the build context
  .env.example           ← committed, names only
  .env.local             ← gitignored: the values
  package.json
  server.ts              ← hosts/docker/server.ts: imports './agent-core' and './site'
  redis-store.ts         ← hosts/docker/redis-store.ts
  agent-core.ts          ← unchanged
  site.ts                ← the BookingSite (from example-site.ts)
  booking-form.json      ← the field spec (and availability.json, for trying it)
```

The page's form must render from the same field spec. Either point the site's build at `booking-agent/booking-form.json`, or make the repository root the build context (`build: { context: .., dockerfile: booking-agent/Dockerfile }`) and copy the spec from where the site keeps it.

The Dockerfile has two stages. The first bundles the TypeScript with esbuild into one `server.mjs`, keeping the packages external. The second is `node:22-alpine`, which installs the runtime dependencies only and runs as `USER node`. Commit a lockfile and use `npm ci` in the project; the reference ships none.

There is no framework. The server reads the request with `node:http` and checks the relay token **before reading the body**. It caps the body at 64 KB **while it streams**, answering 413 rather than buffering first. It builds a web `Request` for the core's `bookingEndpoint` from five headers only, and streams the `Response` back so server-sent events reach the relay one at a time.

**Publish the port on loopback only**:

```yaml
ports:
  - 127.0.0.1:4120:4120   # never 0.0.0.0
```

The relay token is the endpoint's only defense, and `/healthz` says what the agent is configured to do. On a server, traffic reaches the container through the site's reverse proxy, never directly.

## 2. How the relay and the page reach it

**The page never calls it.** The page talks to the relay; the relay talks to the agent.

**The relay** calls `POST /a2a/booking` with `Authorization: Bearer <A2A_RELAY_TOKEN>`. In the agent-handoff adapter, `endpoint` is an absolute URL, since the relay resolves a path against its own origin:

```ts
{ name: 'booking', kind: 'agent', label: 'Northside Booking', description: '…',
  endpoint: process.env.BOOKING_AGENT_URL!,            // http://127.0.0.1:4120/a2a/booking (one replica)
  credential: () => ({ Authorization: `Bearer ${process.env.A2A_RELAY_TOKEN}` }),
  transcript: false, push: false,
  // Straight to the container: /healthz is never routed through the public proxy.
  availability: async () => {
    const res = await fetch('http://127.0.0.1:4120/healthz', { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    return { available: (await res?.json().catch(() => null))?.available === true };
  } }
```

- **One replica.** The endpoint is the container's loopback port, or `http://booking-agent:4120/a2a/booking` when the relay runs in the same compose project
- **Replicas.** Point the endpoint at something that balances them: the reverse proxy's route below, or `https://example.com/a2a/booking`. Read `availability` from one replica's `/healthz` directly. Every replica reports the same store, so one is enough

For the quote agent, both shapes were run with the relay core: through Caddy balancing two replicas, with `/healthz` read from one of them. **Unconfirmed:** a live site's relay process, on the same host as the container, behind TLS.

**The reverse proxy** routes three paths to the container. The two card paths are public, so A2A clients can read the card. `/a2a/booking` is routed so the card's URL answers, with a 403 to anyone without the token. Route `/.well-known/agent-card.json` only if no other agent on the site claims it. Never route `/healthz`.

```
# Caddy, on the site's host
example.com {
	@booking path /a2a/booking /a2a/booking/agent-card.json /.well-known/agent-card.json
	handle @booking {
		# One replica: just 127.0.0.1:4120.
		reverse_proxy 127.0.0.1:4120 127.0.0.1:4121 {
			lb_policy round_robin
			# Caddy reads /healthz from each replica itself; visitors can't.
			health_uri /healthz
		}
	}
	handle {
		root * /srv/site
		file_server
	}
}
```

For the quote agent, this was run with Caddy in the compose network, using service-name upstreams in place of `127.0.0.1`. The cards came back through it, the POST without a token got a 403, `/healthz` got a 404, and the turns of one conversation alternated between the replicas and sent once. **Unconfirmed:** Caddy on the host with loopback upstreams and TLS.

**The card** is built on every request from `PUBLIC_ORIGIN`, never from the `Host` header. Behind a proxy, `Host` is whatever the proxy sent, and a spoofed one must not move the card's URL. The card is the same whichever replica serves it.

## 3. Where secrets live

Locally, `env_file: ./.env.local`, gitignored, with `.env.example` committed with names only. On a server, use the same file outside the repository with owner-only permissions, or a Docker secret. For any secret, `<NAME>_FILE` names a file to read instead: `A2A_RELAY_TOKEN_FILE=/run/secrets/relay_token`. The quote agent ran with a token file mounted at `/run/secrets/`. **Unconfirmed:** compose's own `secrets:` block.

| Variable | |
|---|---|
| `A2A_RELAY_TOKEN` | Required, 32+ characters (`openssl rand -hex 32`); the relay's target sends the same value. No default: unset, the server exits naming it |
| `PUBLIC_ORIGIN` | Required: the site's origin, as the card points at it |
| `BOOKING_SINK_URL` | Required: where the form posts, fixed here. Never from a request |
| `BOOKING_AVAILABILITY_URL` | Required: the site's free-slot endpoint (`httpAvailability` in example-site.ts), fixed here. Unset, the server exits naming it: no calendar, no made-up one |
| `BOOKING_AVAILABILITY_TOKEN` | Sent as the bearer to the availability endpoint, if it wants one |
| `BOOKING_EXAMPLE_CALENDAR` | TEST ONLY. `true`, with no availability URL: the in-memory example calendar, one per replica. Never on a live site |
| `NXIS_WEBHOOK_SIGNING_SECRET` | Signs each post to the sink |
| `ANTHROPIC_API_KEY` | Unset: no model, `available: false`, and the form takes bookings |
| `BOOKING_MODEL` | Default: a current Sonnet |
| `REDIS_URL` | Set by `compose.replicas.yaml` for both replicas at once, never in `.env.local`. A replica left on memory keeps its own claim |

The ways to leak a key are the same as for any container: `ARG`/`ENV` in the Dockerfile (`docker history` prints them), `environment:` in compose (`docker compose config` prints it), and error bodies. A `.dockerignore` that excludes `.env*` keeps the file out of the build context entirely. Settings are read once, at startup: a missing one names itself there, not as a 403 on a visitor's turn.

There is no platform account to cap spending, so set a budget on the API key at Anthropic.

## 4. Where tasks and progress live

**One replica:** the SDK's `InMemoryTaskStore` and the core's `memoryProgress()`. A restart loses conversations in flight; the relay offers the form for those.

**Two or more:** `redis-store.ts`, which holds three keys per task:

- `booking:task:<id>` — the SDK's task (a day)
- `booking:progress:<id>` — the values, the offer, the summary awaiting a yes, the attempt (a day)
- `booking:sent:<id>.<attempt>` — the claim, one per attempt (a week)

The claim is `SET booking:sent:<id>.<attempt> … NX EX 604800`: only the replica whose `SET` creates the key may call the sink, and the same key goes to the sink as `Idempotency-Key`. A slot found taken at the yes spends the attempt; the next slot the visitor confirms books under the next one. Without a shared store, the visitor's "yes" lands on a replica that never showed them the summary. With a shared store but a per-replica claim, two replicas can both send.

Checked with a sink that takes 1.5 s to answer. With the summary on one replica and the yes on the other, it booked once. With the same yes sent to both replicas at once, it booked once, and the second replica answered "Your booking has already been made. Reference NB-…"

**If Redis is down, the agent refuses rather than falls back.** The client runs with `disableOfflineQueue`, so a command fails at once and doesn't wait in a queue. A turn that needs the store fails, and nothing is sent. Falling back to memory would bring back the double submit the claim exists to prevent. Checked by stopping Redis with a summary awaiting a yes:

- `/healthz` on both replicas answered 503 `{"available":false,…,"store":"redis unreachable"}`, and the relay listed `booking` as unavailable
- The yes, on either replica, and a new handoff each get a JSON-RPC error within milliseconds, and the sink receives nothing (the quote agent's run)
- The client reconnected on its own: five seconds after Redis started, `/healthz` answered 200 again

Redis runs without persistence. A Redis restart loses tasks and claims together, so a message to a task from before the restart gets `Task not found` rather than a second send. With `REDIS_URL` set but Redis unreachable at startup, the server exits after two seconds rather than start on memory. `depends_on: condition: service_healthy` keeps that from happening on a cold start.

If a claim's `SET` reaches Redis but its reply is lost, the task reads as sent without having been sent. That is the safe side of the race. The visitor is told it failed and offered the form.

## 5. How long a response may take

There is no limit. A turn is one model call (2–4 s), and an idle stream is held as long as the proxy allows. A replica stopped mid-turn (a deploy, a crash) leaves its task "working". The endpoint's `beforeRead` fails a task that has been working for over 90 seconds the next time the relay reads it, on any replica. Checked for the quote agent by planting a stale task in Redis: `GetTask` on the other replica returned `TASK_STATE_FAILED`. **Unconfirmed:** a replica actually killed during a turn.

The server handles `SIGTERM`: it stops accepting connections, lets the turns in flight finish, closes Redis and exits. Node as PID 1 does not do this by default.

## How to prove it

Locally, before any key, either:

- **The stubs** (what was run): `node lambda/localstack/stubs.mjs sink` (free slots at `/api/slots`, bookings at `/api/book`, on :4129) and `node lambda/localstack/stubs.mjs model` (the Messages API, on :4130). In `.env.local`: `BOOKING_AVAILABILITY_URL=http://host.docker.internal:4129/api/slots`, `BOOKING_SINK_URL=http://host.docker.internal:4129/api/book`, `NXIS_WEBHOOK_SIGNING_SECRET=test-signing-secret`, `ANTHROPIC_API_KEY=test-model-key-not-real` and `ANTHROPIC_BASE_URL=http://host.docker.internal:4130`. Then `RELAY_TOKEN=… SINK=http://127.0.0.1:4129 node lambda/localstack/drive.mjs http://127.0.0.1:4120 http://127.0.0.1:4121` runs every check below against both replicas
- **The scripted model**: `BOOKING_TEST_MODEL=scripted` with `ANTHROPIC_API_KEY` empty, and `BOOKING_EXAMPLE_CALENDAR=true` if there is no calendar to read yet. It passes a reply that is one JSON object of values (`{"service":"drain-cleaning","date":"2026-11-10"}`) on as the details. Every rule around it runs as in production: the calendar, the pick, the summary, the plain yes, the claim and the sink. It is ignored whenever a key is set

```bash
curl -s http://127.0.0.1:4120/healthz                                  # {"available":true,"model":…,"store":…}
curl -s http://127.0.0.1:4120/a2a/booking/agent-card.json                # the card, pointing at PUBLIC_ORIGIN
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' \
  http://127.0.0.1:4120/a2a/booking                                      # 403
head -c 100000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $A2A_RELAY_TOKEN" --data-binary @- http://127.0.0.1:4120/a2a/booking   # 413
```

Then a conversation through the relay (SKILL.md step 7). With replicas, run it once with the summary on one replica and the yes on the other, and once with Redis stopped (`docker compose stop redis`): expect `available: false` and no booking. On one replica, two yeses at once give one booking and an A2A SDK stream error for the second (it refuses a second message to a task still running); across replicas, the second answers "already been made". Then check the logs:

```bash
docker compose logs booking-agent | grep -ciE 'sk-ant|[a-z0-9._-]+@[a-z0-9-]+\.[a-z]|bearer '   # → 0: no key, no email, no token
```

On the server, repeat the cards and the 403 against `https://example.com`, and the conversation from the live page.

## Also on Docker

- **Health check.** `wget -qO- http://127.0.0.1:4120/healthz` (in `node:*-alpine` already; `127.0.0.1`, not `localhost`, which resolves to `::1` first). 503 when Redis is unreachable, so the container and Caddy's balancer both see it
- **Logging, without visitor data.** One line per request: method, path, status, time. No body, no headers, no address. The conversation is the visitor's name, email, phone and job, and the `Authorization` header is the relay token. The core logs a failed turn's error and a failed send's status, neither of which carries the request
- **`restart: unless-stopped`.** The container is the agent. While it is down, the relay lists `booking` as unavailable and the form takes bookings, which is safe but quiet. Watch it
- **No rate limit here.** Visitors reach the agent only through the relay, which ties each to their own task and rate-limits them. The token keeps everyone else out
