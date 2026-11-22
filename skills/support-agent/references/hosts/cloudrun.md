# Google Cloud Run

**Status: draft. Verified locally against the Firestore emulator, never deployed.** The docker profile's Dockerfile, with [`cloudrun/server.ts`](cloudrun/server.ts) as its server, was built and run as two containers sharing one Firestore emulator, with the real `@anthropic-ai/sdk` pointed at a stand-in for the Messages API and stub MCP servers. These were checked: health with and without the token, a not-found turn on one instance and the visitor's "yes" to the offer of a person on the other (handed back `transferred`: the context crossed instances), the gap report sent with its `ref` before the response ended, the turn in `support-turns/<ref>` with `expireAt` at the retention set, the context deleted when the task completed, and the emulator stopped (`/healthz` 503 `firestore unreachable`, a turn ended in an error after the 4 s bound). The in-process tests cover the store over a fake client, two instances sharing it, and the stale-task guard. Not run: anything on Google Cloud (Cloud Run itself, real Firestore, Secret Manager, IAM, the request timeout, CPU throttling, cold starts, the load balancer or Firebase Hosting), and a real model key. Tell the user it is a draft.

Detect: a `Dockerfile` deployed with `gcloud run deploy` (in `package.json` scripts, a Makefile or CI), a `cloudbuild.yaml`, a Cloud Run `service.yaml` (`apiVersion: serving.knative.dev/v1`), a Terraform `google_cloud_run_v2_service`, or `firebase.json` with `"run"` rewrites.

Cloud Run runs **the docker profile's image** and starts as many copies as traffic needs, down to none. Three things change:

- **No memory, no files.** Any request lands on any instance, and an instance's filesystem goes with it. Tasks, context and turns go in Firestore.
- **CPU only while a request is open**, with request-based billing (the default). Work after the response ends may not run.
- **The front door routes the paths**: a Google Cloud load balancer or Firebase Hosting, not a reverse proxy of the user's own.

| Question | Cloud Run |
|---|---|
| Server code | `cloudrun/server.ts`: `docker/node-server.ts` with `cloudrun/firestore-store.ts`. The docker Dockerfile, unchanged |
| Tasks and context | Firestore (Native mode): `support-tasks`, `support-context`, each document expiring after a day |
| Questions and turns | Firestore: `support-questions/<question_key>` for a gap question's wording and `support-turns/<ref>` for a reported turn, expiring after `SUPPORT_TURN_RETENTION_DAYS`. NxisAI gets the key and the ref, never the words |
| Secrets | Secret Manager, read by a dedicated service account |
| Response time | `--timeout=60`. A task a cut-off turn left "working" is failed on its next read, after 90 s |

## 1. Where server code lives

```
support-agent/
  Dockerfile           ← hosts/docker/Dockerfile, unchanged
  .dockerignore        ← hosts/docker/.dockerignore
  .gcloudignore        ← hosts/cloudrun/.gcloudignore: keeps .env* out of the upload
  package.json         ← hosts/cloudrun/package.json (adds @google-cloud/firestore)
  server.ts            ← hosts/cloudrun/server.ts: imports './node-server', './firestore-store', './support-core', './site'
  node-server.ts       ← hosts/docker/node-server.ts
  firestore-store.ts   ← hosts/cloudrun/firestore-store.ts
  support-core.ts      ← unchanged
  site.ts              ← the SupportSite
```

**Build for `linux/amd64`**: `gcloud run deploy --source .` (Cloud Build), or `docker buildx build --platform linux/amd64` and `--image`. `--source` uploads the directory first, and the `.dockerignore` doesn't apply to that upload: the `.gcloudignore` does.

## 2. Why Firestore

A follow-up has to read the context the turn before it wrote, from whichever instance it lands on, so the store has to be shared and strongly consistent. Firestore in Native mode is both, and it is serverless: billed per operation with a free daily quota, nothing running while nobody asks, no VPC path, and TTL policies that delete old documents without a job. A turn is about two context operations and a task write per event, so a conversation is tens of operations (an estimate from the code, not a bill). Memorystore Redis would bill all month and need Direct VPC egress; Cloud SQL, an instance and a connector. If the site already runs a database, put `TaskStore`, `ContextStore` and `TurnStore` over it instead: they are the three interfaces `firestore-store.ts` implements, about 100 lines.

```bash
gcloud firestore databases create --database=support-agent --location=$REGION --type=firestore-native
for c in support-tasks support-context support-turns support-questions; do
  gcloud firestore fields ttls update expireAt --collection-group=$c --database=support-agent --enable-ttl
done
```

TTL deletes within about a day of `expireAt`; nothing relies on when. Every Firestore call is bounded at 4 s (the client's own retries run for minutes): with Firestore down a turn ends in an A2A error within seconds (seen locally: about 4 s), `/healthz` answers 503, and the relay lists the agent unavailable. The owner reads a gap's wording with `findGapQuestionIn(db, question_key)` and its turns with `findTurnIn(db, ref)`, or in the console at `support-questions/<question_key>` and `support-turns/<ref>`. A question asked again keeps its `firstSeen`, and its `lastSeen` and expiry move on.

## 3. CPU: the response stays open for the gap reports

Request-based billing gives an instance CPU only while it has a request open. Each write a turn depends on happens before the turn's final event: the SDK saves the task for each event before writing it, and the core saves the context before it publishes the reply. Gap reports go *after* the reply. So the server **holds the response open until that turn's reports have settled**, at most `SUPPORT_REPORT_WAIT_MS` (5 s): the reply's events are already written, the visitor waits for nothing, and the stream ends about one provisioning round trip later. The turn is saved in `support-turns` just before its report, inside the same window.

This was chosen over instance-based billing (`--no-cpu-throttling`, "CPU always allocated"), which bills every instance for its whole life, idle time included, to run a few hundred milliseconds of work that fits inside the request anyway. A report the provisioning server takes longer than 5 s over is let go and may not finish; it is a gap count, never the visitor's answer. **Unconfirmed:** Cloud Run's real throttling of a request held open this way (locally, the containers aren't throttled).

## 4. Secrets

Secret Manager, one secret per value, read by a dedicated runtime service account, never the default compute one (Editor on the project):

```bash
SA=support-agent@$PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts create support-agent --display-name="Support Agent (Cloud Run runtime)"

# Values from stdin, never on the command line or in a file in the repo.
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create support-relay-token --data-file=-
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create support-turn-ref-secret --data-file=-   # question keys and turn references; without it, no gap reports
gcloud secrets create support-anthropic-key --data-file=-     # paste the key, then Ctrl-D
nxis keys create --scope content_gaps:report --site <site> --json | jq -j .api_key \
  | gcloud secrets create support-gap-key --data-file=-       # never printed
for s in support-relay-token support-turn-ref-secret support-anthropic-key support-gap-key; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/datastore.user \
  --condition="expression=resource.name==\"projects/$PROJECT/databases/support-agent\",title=support-agent-db"
```

Passed as variables (`--set-secrets`), a secret is read when an instance starts; deploy a new revision to roll a new version out. `gcloud run services describe` shows names, not values. As files, mount each in its own directory and set `<NAME>_FILE`. **Unconfirmed:** the IAM condition on the database name, and the file form.

`PUBLIC_ORIGIN`, `SUPPORT_MCP_ENDPOINT`, `SUPPORT_PROVISIONING_ENDPOINT`, `FIRESTORE_DATABASE` and `SUPPORT_TURN_RETENTION_DAYS` (what the owner said) are plain variables.

## 5. Time, instances, health

- **`--timeout=60`.** A turn is a rewrite, up to seven reads and a compose with one retry, then up to 5 s held for its reports: well inside 60 s, and shorter than the 90 s after which a task left "working" is failed on its next read (`beforeRead`, any instance)
- **`--min-instances=0`.** Free while idle. A cold start opens the Firestore client while the startup probe waits; the relay's `availability` gives up after 1 s, so the first page after a quiet spell may not offer the agent. `--min-instances=1` avoids that, at the idle rate, all month. `--cpu-boost` shortens every start
- **`--concurrency=40`, `--max-instances=3`.** A turn is mostly waiting; the ceiling caps spend. Each response waits for its own turn's reports only
- **Startup probe on `/healthz`**, which answers 503 until Firestore does: a missing permission fails the deploy, not the first visitor. No liveness probe. The Dockerfile's `HEALTHCHECK` is ignored here
- **`SIGTERM`**, then `SIGKILL` ten seconds later: the server finishes its requests and reports within `SUPPORT_SHUTDOWN_MS` (8 s)

## 6. The front door, and the deploy

The page never calls the agent; the relay does, with `Authorization: Bearer <A2A_RELAY_TOKEN>`. Cloud Run's invoker IAM check would need a Google ID token in that header instead, and would make the card private, so deploy with `--no-invoker-iam-check` and let the token be the defense, as on Docker. Route `/a2a/support` and `/a2a/support/*` (and `/.well-known/agent-card.json` if nothing else claims it) through the site's load balancer (a serverless NEG, with `--ingress=internal-and-cloud-load-balancing`) or Firebase Hosting rewrites (`--ingress=all`). Never route `/healthz`; the relay reads `https://<site>/a2a/support/healthz`. The quote-agent skill's `hosts/cloudrun.md` has both written out; only the paths differ.

Written for the user to run, in a project they choose. None of it has been run.

```bash
PROJECT=…; REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com
# Firestore and its TTL policies (section 2), the service account and the secrets (section 4). Then, from support-agent/:
gcloud run deploy support-agent --source . --region=$REGION \
  --service-account=support-agent@$PROJECT.iam.gserviceaccount.com \
  --port=4130 --cpu=1 --memory=512Mi --cpu-throttling --cpu-boost \
  --min-instances=0 --max-instances=3 --concurrency=40 --timeout=60 \
  --ingress=internal-and-cloud-load-balancing --no-invoker-iam-check \
  --startup-probe=httpGet.path=/healthz,httpGet.port=4130,periodSeconds=2,timeoutSeconds=2,failureThreshold=15 \
  --set-env-vars=PUBLIC_ORIGIN=https://example.com,SUPPORT_MCP_ENDPOINT=https://example.com/mcp,SUPPORT_PROVISIONING_ENDPOINT=<provisioning URL>,FIRESTORE_DATABASE=support-agent,SUPPORT_TURN_RETENTION_DAYS=30 \
  --set-secrets=A2A_RELAY_TOKEN=support-relay-token:latest,ANTHROPIC_API_KEY=support-anthropic-key:latest,SUPPORT_GAP_KEY=support-gap-key:latest,SUPPORT_TURN_REF_SECRET=support-turn-ref-secret:latest
```

Without `SUPPORT_TURN_REF_SECRET` in `--set-secrets`, no gap or close report is sent: a question goes to NxisAI as a keyed hash or not at all. The provisioning server must take `question_key`.

## How to prove it

**Locally, against the emulator** (no credentials: with `FIRESTORE_EMULATOR_HOST` set, the client talks only to it, and a `demo-` project can't name a real one):

```bash
docker network create support-test
docker run -d --name fs --network support-test google/cloud-sdk:emulators \
  gcloud emulators firestore start --host-port=0.0.0.0:8080
docker build -t support-agent .
for p in 4131 4132; do
  docker run -d --network support-test -p 127.0.0.1:$p:4130 -e PORT=4130 \
    -e FIRESTORE_EMULATOR_HOST=fs:8080 -e GOOGLE_CLOUD_PROJECT=demo-support --env-file .env.local support-agent
done
```

Then the docker profile's checks on both ports, `"store":"firestore"` in `/healthz` with the token, one conversation with its turns alternating between the two, and `docker stop fs`: 503 and `available: false`. The emulator image is amd64 and takes about 30 s to start under emulation on an Apple Silicon Mac. Outside Google Cloud the client also waits out a metadata-server lookup on its first call (about 1.5 s), so the first `/healthz` may say unreachable.

**On Cloud Run**, after the deploy: `gcloud run services describe` (service account, secret names, ingress, probe); `https://example.com/a2a/support/healthz` → `{"available":true}`; `https://example.com/healthz` → the site's own 404; the `run.app` URL refused with `internal-and-cloud-load-balancing`; POST without the token → 403; SKILL.md step 7 from the live page, with one unanswerable question whose gap appears on the list by its key, whose wording is in `support-questions` and whose turn is in `support-turns`; Logs Explorer shows one line per request and no key, token or question.
