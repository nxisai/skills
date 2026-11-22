# Google Cloud Run

**Status: draft. Verified locally against the Firestore emulator with stubs; never deployed.** `hosts/cloudrun/server.ts` ran on Node 22 as two instances sharing one Firestore emulator (`google/cloud-sdk:emulators`), with the real `@anthropic-ai/sdk` pointed at a stub of the Messages API and a stub site serving free slots and taking bookings (`lambda/localstack/stubs.mjs`), driven by `lambda/localstack/drive.mjs`: `/healthz` and `/a2a/booking/healthz` (the full answer only with the token), both cards at `PUBLIC_ORIGIN`, 403 without or with a wrong token, 413 over 64 KB, a conversation from the calendar's offer through a pick, the details and the summary to one signed booking with the sink's reference, the summary on one instance and the yes on the other, and the same yes on both at once (one booking, both replies carrying the reference). `booking-agent.tf` passes `terraform validate`. Not run for the booking agent: the image on the emulator (the Docker image itself was run in the Docker profile), the emulator stopped and restarted, a stale task, `SIGTERM` mid-turn, the Memorystore path, and anything on Google Cloud — Cloud Run itself, real Firestore, Secret Manager, IAM, the load balancer, Firebase Hosting — and a real model key. Where the sections below describe a check without saying so, it was the quote agent's run of this same server. Tell the user which parts are a draft, and confirm each item marked **Unconfirmed** before relying on it.

Detect: a `Dockerfile` the user deploys with `gcloud run deploy`, a `cloudbuild.yaml`, a `firebase.json` with `"run"` rewrites, a Terraform `google_cloud_run_v2_service`, or a site already behind a Google Cloud load balancer. The user wants the agent as its own service, but not a server or VM of their own.

Cloud Run runs the **same container as the Docker profile** and starts as many copies as traffic needs, down to none. Three things change because of that:

- **Never memory.** Instances come and go, and a request lands on any of them. Tasks, progress and the claim live in Firestore, or Memorystore.
- **CPU only during a request**, by default. Anything the server does after the response ends may not run.
- **No reverse proxy of the user's own.** The site's front door — a Google Cloud load balancer, or Firebase Hosting — routes the agent's paths.

It answers the five host questions like this:

| Question | Cloud Run |
|---|---|
| Server code | `hosts/cloudrun/server.ts` on `node:http`: the Docker server with Firestore as its store, built with the Docker profile's Dockerfile. Locally: `docker run` against the Firestore emulator |
| Tasks and progress | Firestore (Native mode), by default: serverless, billed per operation, nothing running while idle. Memorystore Redis as the alternative, through the Docker profile's `redis-store.ts` |
| Conditional write | Firestore `create()`, which fails if the document exists. Memorystore: `SET NX`, as on Docker |
| Secrets | Secret Manager, as environment variables or mounted files (`<NAME>_FILE`), read by a dedicated service account allowed those secrets and nothing else |
| Response time | The service's request timeout: 60 s here. One turn is one model call (2–4 s) and at most one sink call. A turn cut off leaves its task "working"; the next read fails it |

## 1. Where server code lives

Beside the site, as on Docker, with the Cloud Run server and the Firestore store in place of the Docker server:

```
booking-agent/
  Dockerfile             ← hosts/docker/Dockerfile, unchanged
  .dockerignore          ← hosts/docker/.dockerignore
  .gcloudignore          ← hosts/cloudrun/.gcloudignore: keeps .env* out of the upload
  package.json           ← hosts/cloudrun/package.json (adds @google-cloud/firestore)
  server.ts              ← hosts/cloudrun/server.ts: imports './agent-core', './site',
                            './redis-store', './firestore-store'
  firestore-store.ts     ← hosts/cloudrun/firestore-store.ts
  redis-store.ts         ← hosts/docker/redis-store.ts (Memorystore; imported either way)
  agent-core.ts          ← unchanged
  site.ts                ← the BookingSite (from example-site.ts)
  booking-form.json      ← the field spec (and availability.json, for trying it)
  booking-agent.tf         ← optional: hosts/cloudrun/booking-agent.tf
```

`server.ts` is the Docker server with three differences, each marked `CLOUD RUN` in the file:

- **The store.** Firestore unless `REDIS_URL` is set; never memory. Cloud Run may run more instances than `--max-instances` for a short time during a rollout, so even one instance is no guarantee of one claim.
- **`/healthz`.** Without the relay token it answers `{"available": …}` and nothing else, because a `run.app` URL is public when the service allows unauthenticated calls. With the token, it adds the model and the store, as on Docker. A Firestore ping is a billed read, so a good answer is kept for five seconds.
- **`/a2a/booking/healthz`.** The same answer, under the path the front door already routes, for the relay's `availability`.

Everything else is the Docker server's: the token checked before the body is read, the 64 KB cap while it streams, the card built from `PUBLIC_ORIGIN`, one log line per request with no visitor data, and `SIGTERM` handling. Cloud Run sends `SIGTERM` and then `SIGKILL` ten seconds later. The server stops taking connections, lets the turns in flight finish, and exits within nine seconds.

**Build for `linux/amd64`.** Cloud Run runs amd64 images. On an Apple Silicon Mac, `docker build` makes arm64, so use `docker buildx build --platform linux/amd64`, or let Cloud Build build it (`gcloud run deploy --source .`). `--source` uploads the directory to a Cloud Storage bucket first. Without a `.gcloudignore`, gcloud derives one from `.gitignore`. The Dockerfile's `.dockerignore` is applied later, inside the build, and doesn't stop the upload — so `.gcloudignore` excludes `.env*` explicitly.

## 2. CPU is only there during a request

By default, Cloud Run gives an instance CPU only while it is handling a request. Request-based billing works this way (`--cpu-throttling`, the default). Once the response has ended, the instance is throttled almost to nothing until its next request, and it may be stopped. So **every write a turn depends on must finish before the response ends.**

The server already guarantees that. The response is the SDK's event stream, and it ends right after the turn's final event (`INPUT_REQUIRED` or `COMPLETED`). Each of these happens before that event:

| Write | When |
|---|---|
| The SDK's task (`booking-tasks`) | Saved for each event, before that event is written to the stream |
| Progress, the summary awaiting a yes (`booking-progress`) | In the turn's `finally`, before the final event is published |
| The claim (`booking-sent`) | Before the sink is called, inside the turn |
| The sink call | Inside the turn: the hand-back carries the sink's reference, so the turn can't end before the sink answers |

One write comes after: when a turn **completes**, the core deletes that task's progress after publishing the hand-back. It may run late, or not at all if the instance is stopped first. That is harmless. The claim document stops a second send, nothing reads progress for a completed task, and the TTL policy removes it within a day or so.

Checked locally by freezing the container (`docker pause`, the cgroup freezer: no CPU at all) 35–100 ms after each response ended, then reading the emulator directly. The task, the progress with its pending summary, the claim and the sink's one post were all there. Each document's `updateTime` was 4–61 ms *before* the response ended (the claim, 1.5 s before: the stub sink takes 1.5 s). The completed task's progress was already gone by the time of the freeze. **Unconfirmed:** Cloud Run's real throttling, which a frozen container only approximates.

Don't switch to instance-based billing (`--no-cpu-throttling`) for this. It costs more for no gain here.

## 3. How the relay and the page reach it

**The page never calls it.** The page talks to the relay; the relay talks to the agent.

**Same-origin, through the site's front door (the default).** The front door routes three paths to the service: `/a2a/booking`, `/a2a/booking/*` (the card and the relay's health), and `/.well-known/agent-card.json` only if no other agent on the site claims it. It never routes `/healthz`. The card's URL is then on the site's own origin, as on every other profile.

- **A global external Application Load Balancer** already in front of the site: a serverless NEG for the service, a backend service, and a path rule in the existing URL map. Deploy with `--ingress=internal-and-cloud-load-balancing`, so the `run.app` URL refuses the internet and only the load balancer reaches the service. If the site doesn't have one already, a load balancer has a monthly forwarding-rule charge of its own. Use Firebase Hosting or the service's own origin instead.

  ```bash
  gcloud compute network-endpoint-groups create booking-agent-neg \
    --region=$REGION --network-endpoint-type=serverless --cloud-run-service=booking-agent
  gcloud compute backend-services create booking-agent-backend --global \
    --load-balancing-scheme=EXTERNAL_MANAGED
  gcloud compute backend-services add-backend booking-agent-backend --global \
    --network-endpoint-group=booking-agent-neg --network-endpoint-group-region=$REGION
  # Then, in the site's URL map's path matcher (gcloud compute url-maps edit, or Terraform):
  #   paths: /a2a/booking, /a2a/booking/*, /.well-known/agent-card.json  →  booking-agent-backend
  ```

- **Firebase Hosting** in front of the site: rewrites to the service, in `firebase.json`, before any catch-all rewrite:

  ```json
  "rewrites": [
    { "source": "/a2a/booking", "run": { "serviceId": "booking-agent", "region": "us-central1" } },
    { "source": "/a2a/booking/**", "run": { "serviceId": "booking-agent", "region": "us-central1" } },
    { "source": "/.well-known/agent-card.json", "run": { "serviceId": "booking-agent", "region": "us-central1" } }
  ]
  ```

  **Unconfirmed:** that Hosting's rewrites need the service's ingress at `all`, that they pass `Authorization` through, and that they deliver the server-sent events of a turn. They may arrive buffered, all at the end, which the relay still reads, since a turn is seconds long. Hosting's rewrites to Cloud Run time out at 60 seconds.

**Own origin (the alternative).** The `run.app` URL, or a domain mapped to the service. `PUBLIC_ORIGIN` is that origin, the card's URL is on it, and the relay's `endpoint` is `https://<service URL>/a2a/booking`. Use it when the site has no front door that routes paths, or when the agent serves several sites. Use `--ingress=all`.

**Cloud Run's IAM check is off, and the relay token is the defense — as on Docker.** The relay sends `Authorization: Bearer <A2A_RELAY_TOKEN>`. With Cloud Run's invoker IAM check on, that header would have to carry a Google-signed ID token instead, and Cloud Run would reject the relay's bearer before the container saw it. The cards would stop being public too. A load balancer can't add an ID token for a visitor's A2A client, and the cards have to be readable without one. So deploy with `--no-invoker-iam-check`. That flag turns the check off without granting `allUsers` the invoker role, and it works under an organization policy that forbids `allUsers` (`--allow-unauthenticated` does the same where `allUsers` is allowed). The server refuses any POST without the token (403) before reading its body. The front door's routing and `internal-and-cloud-load-balancing` keep everything but the three paths away.

If the user wants IAM as well (defense in depth, own origin only): leave the check on and grant the relay's service account `roles/run.invoker` on this service. The relay then sends its Google ID token in `X-Serverless-Authorization`, which Cloud Run checks first and strips, and the relay token in `Authorization` as before. The cards must then be served by the site itself, as static files built from the same `bookingAgentCard` call, since Cloud Run would refuse an anonymous card request. **Unconfirmed:** this path wasn't run.

**The relay's target**, in the agent-handoff adapter:

```ts
{ name: 'booking', kind: 'agent', label: 'Northside Booking', description: '…',
  endpoint: 'https://example.com/a2a/booking',          // through the front door; or the service's own URL
  credential: () => ({ Authorization: `Bearer ${process.env.A2A_RELAY_TOKEN}` }),
  transcript: false, push: false,
  // Through the front door, with the token: /healthz itself is never routed.
  availability: async () => {
    const res = await fetch('https://example.com/a2a/booking/healthz', {
      headers: { Authorization: `Bearer ${process.env.A2A_RELAY_TOKEN}` },
      signal: AbortSignal.timeout(1_000),
    }).catch(() => null);
    return { available: (await res?.json().catch(() => null))?.available === true };
  } }
```

**The card** is built on every request from `PUBLIC_ORIGIN`, never from the `Host` header, and is the same from every instance.

## 4. Where tasks and progress live

### Firestore (Native mode) — the default

`firestore-store.ts` keeps three documents per task. Each holds an `expireAt` timestamp for a TTL policy:

| Collection | Document | `expireAt` |
|---|---|---|
| `booking-tasks` | the SDK's task, as JSON in one string field | a day |
| `booking-progress` | the values, the offer, the summary awaiting a yes, the attempt, as JSON | a day |
| `booking-sent` | the claim, one document per attempt (`<task>.<attempt>`): when, and a random `by` | a week |

**The claim is `create()`.** Firestore writes the document only if it doesn't exist, atomically, on the server. Only the instance whose `create()` succeeds re-checks the slot and calls the sink, with the same key as `Idempotency-Key`. The client retries a commit that failed `UNAVAILABLE`. A first attempt that landed with its reply lost therefore comes back as "already exists", and the `by` nonce tells our own claim from another instance's. A lost reply neither sends twice nor tells the visitor "already sent" when nothing was.

Checked against the emulator, with two instances and a stub sink that takes 1.5 s:

- With the summary on one instance and the yes on the other, it booked once
- The same yes sent to both instances at once booked once, and the other answered "Your booking has already been made. Reference NB-…"
- For the quote agent, `claim()` was called directly, 2 and 3 at a time from two clients, 25 rounds each: one winner every round. At 6 at a time, the emulator took 2–4 s per round under contention, and one call hit the 4-second bound and failed, so nothing was sent. That is the safe side. Real traffic has at most two (a retry, or a double yes). **Unconfirmed:** contention timings on real Firestore

**If Firestore is unreachable, the agent refuses rather than falls back.** Every call is bounded at 4 seconds (1.5 s for the health ping), because the client's own retries run for up to ten minutes. A turn that needs the store fails, the relay offers the form, and nothing is sent. Checked for the quote agent by stopping the emulator with a summary awaiting a yes:

- The relay's health path on both instances answered 503 `{"available":false,…,"store":"firestore unreachable"}` within 1.5 s
- The yes, on either instance, and a new handoff each got a JSON-RPC error after 4 s. The sink received nothing. Neither process crashed
- After the emulator restarted, both instances were healthy again within seconds and a new conversation crossed instances and sent once. The emulator keeps nothing across a restart, so the old task answered `Task not found` rather than sending. Real Firestore doesn't lose data that way

A task left "working" for over 90 seconds — an instance stopped mid-turn, or a request that timed out — is failed the next time the relay reads it (`beforeRead`), on any instance. Checked for the quote agent by planting one in the emulator: `GetTask` on the other instance returned `TASK_STATE_FAILED`.

**Setup** (once per project). The database's location is permanent. Use the Cloud Run region, or the multi-region that holds it.

```bash
gcloud firestore databases create --database=booking-agent --location=$REGION --type=firestore-native
for c in booking-tasks booking-progress booking-sent; do
  gcloud firestore fields ttls update expireAt --collection-group=$c --database=booking-agent --enable-ttl
done
```

A named database (`booking-agent`, set with `FIRESTORE_DATABASE`) keeps the agent's data apart from anything else in the project, and lets its role be limited to that database. **Cost:** Firestore's free daily quota covers one database per project. If the project's `(default)` database is unused, or already Native mode and free to share, `FIRESTORE_DATABASE=(default)` keeps the agent inside that quota. Check the current pricing page. Each turn reads the task and the progress and writes them back (the task once per event), so a five-turn conversation is on the order of 15–25 document writes, 10–15 reads, a claim and a few deletes: cents per thousand conversations, and usually inside the free quota. (An estimate from the code, not a measured bill.)

TTL deletes documents within about a day of `expireAt`, not at it. Nothing relies on when.

### Memorystore Redis — the alternative

Set `REDIS_URL`, and the server uses the Docker profile's `redis-store.ts` unchanged, with the claim as `SET NX` (checked for the quote agent against a Redis container: one conversation, one submission). The costs are the reason it isn't the default:

- An instance runs, and bills, all month, idle or not. The smallest Basic tier still has a monthly floor
- Cloud Run reaches it only through the VPC: Direct VPC egress (`--network`, `--subnet`, `--vpc-egress=private-ranges-only`), or a Serverless VPC Access connector, whose VMs are another always-on charge
- With `REDIS_URL` set and Redis unreachable at startup, the instance exits, as on Docker, and Cloud Run tries another

Use it when the project already runs Memorystore for something else.

## 5. Where secrets live

Secret Manager, one secret per value, read by a **dedicated runtime service account**. Never the default compute service account, which has Editor on the project.

```bash
SA=booking-agent@$PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts create booking-agent --display-name="Booking Agent (Cloud Run runtime)"

# Values from stdin, never on the command line (shell history) or in a file in the repo.
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create booking-relay-token --data-file=-
gcloud secrets create booking-anthropic-key --data-file=-          # paste the key, then Ctrl-D
gcloud secrets create booking-sink-signing-secret --data-file=-    # the binding's signing secret
for s in booking-relay-token booking-anthropic-key booking-sink-signing-secret; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done

# Firestore: documents in the booking-agent database only.
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/datastore.user \
  --condition="expression=resource.name==\"projects/$PROJECT/databases/booking-agent\",title=booking-agent-db"
```

**Unconfirmed:** the IAM condition on the database name. Without it, `roles/datastore.user` covers every database in the project. The relay's own copy of the token goes wherever the relay keeps its secrets. If the relay also runs on Cloud Run, that is the same secret, read by the relay's service account.

As environment variables (`--set-secrets=A2A_RELAY_TOKEN=booking-relay-token:latest,…`), a secret is read when an instance starts. A new version reaches new instances; deploy a new revision to roll it everywhere. `gcloud run services describe` shows the secret's name, not its value. As files instead, mount each secret in its own directory and point `<NAME>_FILE` at it: `--set-secrets=/secrets/relay/token=booking-relay-token:latest` with `A2A_RELAY_TOKEN_FILE=/secrets/relay/token`. The server reads `<NAME>_FILE` already. **Unconfirmed:** the file form on Cloud Run.

| Variable | |
|---|---|
| `A2A_RELAY_TOKEN` | Secret. Required, 32+ characters. Unset, the server exits naming it, and the revision fails its startup probe |
| `ANTHROPIC_API_KEY` | Secret. Unset: no model, `available: false`, and the form takes bookings |
| `NXIS_WEBHOOK_SIGNING_SECRET` | Secret. Signs each post to the sink |
| `PUBLIC_ORIGIN` | Plain. The site's origin, as the card points at it |
| `BOOKING_SINK_URL` | Plain. Where the form posts, fixed here |
| `BOOKING_AVAILABILITY_URL` | Plain. The site's free-slot endpoint, fixed here. Unset, the server exits naming it. Its bearer, if it wants one, is a secret: `BOOKING_AVAILABILITY_TOKEN` |
| `BOOKING_MODEL` | Plain. Default: a current Sonnet |
| `FIRESTORE_DATABASE` | Plain. `booking-agent`, or `(default)` |
| `REDIS_URL` | Plain. Only for Memorystore |

Never `BOOKING_TEST_MODEL` on a deployed service. The server ignores it whenever a key is set, and with no key, the relay lists `booking` as unavailable.

Set a budget on the API key at Anthropic, and a billing budget alert on the project.

## 6. How long a response may take, and how many run at once

- **Request timeout: `--timeout=60`.** A turn is one model call and at most one sink call, a few seconds. 60 s is generous, and shorter than the 90 s after which a task left "working" is failed. A turn cut off by the timeout is therefore failed on its next read. Raise it only if the sink is slow
- **Min instances 0, and cold starts.** With none idle, the first request after a quiet spell starts an instance. Locally the server listens within half a second. The first Firestore call then waits on the client's start-up, and outside Google Cloud it also waited out a metadata-server lookup, about 3 s. The server opens the client at startup, while the startup probe waits, rather than on a visitor's turn. The relay's `availability` gives up after 1 s, so **the first page after a quiet spell may list `booking` as unavailable and offer the form.** The page after that finds a warm instance. That is safe, and free. To avoid it, `--min-instances=1` keeps one instance idle at the idle rate, a monthly cost. `--cpu-boost` shortens every start. **Unconfirmed:** cold-start times on Cloud Run
- **Concurrency: `--concurrency=40`.** A turn is mostly waiting on the model and the sink, so one Node process handles many at once. `--max-instances=3` puts a ceiling on spend. More requests than that queue briefly, then get a 429, and the relay offers the form
- **Health checks.** A startup probe on `/healthz`: `--startup-probe=httpGet.path=/healthz,httpGet.port=4120,periodSeconds=2,timeoutSeconds=2,failureThreshold=15`. It answers 503 until the store does, so a missing Firestore permission fails the deploy instead of the first visitor. There is no liveness probe: restarting an instance doesn't fix a Firestore or Memorystore outage, and `/healthz` already makes the relay list `booking` as unavailable. The Dockerfile's `HEALTHCHECK` is ignored on Cloud Run

## 7. The deploy recipe

Written for the user to run, in a project they choose. None of it has been run.

```bash
PROJECT=…; REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com

# 1. Firestore, the TTL policies, the service account and the secrets: sections 4 and 5.

# 2. Build and deploy, from booking-agent/.
gcloud run deploy booking-agent --source . --region=$REGION \
  --service-account=booking-agent@$PROJECT.iam.gserviceaccount.com \
  --port=4120 --cpu=1 --memory=512Mi --cpu-throttling --cpu-boost \
  --min-instances=0 --max-instances=3 --concurrency=40 --timeout=60 \
  --ingress=internal-and-cloud-load-balancing --no-invoker-iam-check \
  --startup-probe=httpGet.path=/healthz,httpGet.port=4120,periodSeconds=2,timeoutSeconds=2,failureThreshold=15 \
  --set-env-vars=PUBLIC_ORIGIN=https://example.com,BOOKING_SINK_URL=https://example.com/api/book,BOOKING_AVAILABILITY_URL=https://example.com/api/slots,FIRESTORE_DATABASE=booking-agent \
  --set-secrets=A2A_RELAY_TOKEN=booking-relay-token:latest,ANTHROPIC_API_KEY=booking-anthropic-key:latest,NXIS_WEBHOOK_SIGNING_SECRET=booking-sink-signing-secret:latest

# 3. The front door: section 3.
```

With Firebase Hosting or the service's own origin, use `--ingress=all`. With a prebuilt image, pass `--image` instead of `--source`: `docker buildx build --platform linux/amd64`, pushed to Artifact Registry.

The same, as Terraform: `hosts/cloudrun/booking-agent.tf` (Firestore, the TTL policies, the service account and its two bindings, the service). `terraform validate` passes with provider 8.9. It has not been planned or applied. It leaves the secrets' values and the front door to the user.

## How to prove it

**Locally, against the Firestore emulator, before any key or any Google Cloud resource.** No credentials are involved: with `FIRESTORE_EMULATOR_HOST` set, the client sends every call to the emulator, which takes any project ID. A `demo-` ID can't name a real project, so a mistake fails rather than writes somewhere real.

```bash
docker network create booking-test
docker run -d --name fs --network booking-test google/cloud-sdk:emulators \
  gcloud emulators firestore start --host-port=0.0.0.0:8080
docker build -t booking-agent .
docker run -d --name booking --network booking-test -p 127.0.0.1:4120:4120 \
  -e FIRESTORE_EMULATOR_HOST=fs:8080 -e GOOGLE_CLOUD_PROJECT=demo-booking \
  --env-file .env.local booking-agent   # .env.local: token, origin, the stubs' URLs (docker.md, "How to prove it")
```

Then the Docker profile's checks ("How to prove it" in docker.md), on `127.0.0.1:4120`: `/healthz` (`{"available":true}` without the token; the model and `"store":"firestore"` with it), both cards, 403 without the token, 413 over 64 KB, and a conversation to one submission. Run a second container on `4121` against the same emulator: the summary on one, the yes on the other, and the same yes on both at once. Then `docker stop fs`: expect 503 and `available: false`, an error and no submission for a yes, and both healthy again after `docker start fs`.

The emulator image is amd64. On an Apple Silicon Mac it runs under emulation and takes about 30 seconds to start.

**On Cloud Run**, after the deploy:

| Check | Expect |
|---|---|
| `gcloud run services describe booking-agent --region=$REGION` | The service account, the secrets by name, `ingress`, the startup probe |
| `curl https://example.com/a2a/booking/healthz` | `{"available":true}` and nothing else. With `-H "Authorization: Bearer …"`: the model and `"store":"firestore"` |
| `curl https://example.com/healthz` | The site's own 404, not the agent |
| The `run.app` URL, with `internal-and-cloud-load-balancing` | 404 from Google's front end: it refuses the internet |
| Both card URLs through the front door | The card, pointing at `PUBLIC_ORIGIN` |
| `POST https://example.com/a2a/booking` with no token | 403 |
| A conversation from the live page (SKILL.md step 7) | One booking. In the Firestore console, one `booking-sent` document, `<task>.0` |
| The first handoff after an idle spell | Possibly the form (a cold start). The next one, the agent |
| Logs Explorer, `resource.labels.service_name="booking-agent"` | One line per request; no key, no visitor email, no token |
| Remove the service account's `roles/datastore.user`, deploy a revision | The revision fails its startup probe; the old one keeps serving |

## Also on Cloud Run

- **Logging, without visitor data.** The Docker server's one line per request — method, path, status, time — goes to Cloud Logging from stdout. Cloud Run's own request logs record the URL path, status, latency and the caller's IP. They never record headers or bodies, so neither the relay token nor the conversation reaches them
- **No rate limit here.** As on Docker, visitors reach the agent only through the relay, which rate-limits them. The token keeps everyone else out. `--max-instances` caps the spend if something gets through anyway
- **Regions.** Put the service, the Firestore database and Memorystore (if used) in one region. A Firestore call across regions adds tens of milliseconds to each of the six or so a turn makes
- **Rollouts.** A new revision takes traffic while the old one finishes its requests. Both share Firestore, so a conversation crossing the rollout keeps its summary and its claim
