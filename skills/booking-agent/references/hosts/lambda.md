# AWS Lambda

**Status: draft — verified locally against DynamoDB Local; not deployed, to LocalStack or AWS.** `local-check.ts` ran the handler with synthetic Function URL events against DynamoDB Local (`amazon/dynamodb-local` in Docker) with a scripted model, the example calendar and a stub sink: both cards at `PUBLIC_ORIGIN`, 403 without or with a wrong token, 413 over 64 KB, a conversation from the calendar's offer through a pick, the details and the summary to one signed booking with the sink's reference, two "yes" at once from two Node processes (two "containers") → one booking, both replies carrying the reference, and 20 concurrent claims on one attempt → exactly one true, with the next attempt's key still free. The template and the LocalStack recipe below are the quote agent's, which ran on LocalStack 4.2.1, with the booking agent's names, the availability URL and its parameter added; this version has not been deployed there. `drive.mjs` and `stubs.mjs` did run, against the Docker, Cloud Run and Cloudflare profiles. **Not run on AWS:** IAM enforcement, CloudFront routing, KMS behind SSM, a real model call and AWS cold starts. Tell the user so, and confirm each item marked **Unconfirmed** before relying on it.

Detect: a `template.yaml` with `AWS::Serverless`, a `cdk.json`, Terraform with `aws_lambda_function`, a site served from S3 + CloudFront, or a user who says the site's server code runs on AWS.

```
visitor ⇄ page ── /api/handoff (relay) ──▶ https://example.com/a2a/booking ──CloudFront──▶ Function URL ──▶ handler.ts
                                                                                       │   DynamoDB: task#, progress#, sent#
                                                                                       └─  SSM: model key, relay token, signing secret
```

Files: `lambda/handler.ts` (the function), `lambda/template.yaml` (SAM), `lambda/.env.example` (names only), `lambda/local-check.ts` (the local check), `lambda/localstack/` (test-only stubs and an HTTP driver for the LocalStack run).

## 1. Where server code lives, and what it runs on locally

One function, Node 22 (`nodejs22.x`, arm64), behind a **Lambda Function URL**. Put `handler.ts`, `agent-core.ts` (unchanged), the site adapter, the field spec JSON and a `package.json` in one folder — the template's `CodeUri` — and change the two imports in `handler.ts` to `./agent-core` and `./<adapter>`. `sam build` bundles it with esbuild; the dependencies are `@a2a-js/sdk`, `@anthropic-ai/sdk`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-ssm` (bundled, not taken from the runtime, so versions are pinned), and `@types/aws-lambda`, `esbuild` as dev dependencies.

**Function URL, not API Gateway.** Pick the Function URL:

- One resource and no extra charge; API Gateway adds a resource, a stage and per-request pricing for nothing this endpoint uses
- API Gateway HTTP APIs cut an integration off at 30 s; a Function URL runs to the function's timeout
- Only Function URLs support Lambda response streaming, should the agent ever need it
- Authentication is the relay's bearer, checked in code either way

What a Function URL lacks is throttling: cap spend with `ReservedConcurrentExecutions` (commented in the template — a new account with a concurrency quota of 10 can't reserve any) and the vendor's budget on the model key. Visitors are rate-limited by the relay before they reach the agent. Use API Gateway only if the account's policy requires it (WAF on the API, usage plans); the handler takes the same event shape (payload format 2.0).

`AuthType: NONE`. **Not** `AWS_IAM` with CloudFront Origin Access Control: OAC signs the origin request with SigV4 in the `Authorization` header — the header the relay's bearer travels in — and needs the caller to send `x-amz-content-sha256` on a POST, which the relay doesn't. Anyone who finds the Function URL still gets 403 without the token.

Locally, there's no server to start: `local-check.ts` imports `handler` and calls it with Function URL events. For the deployed shape — the template, the Function URL, SSM, the runtime image — use LocalStack ([below](#try-it-on-localstack)). `sam local start-api` is the alternative where SAM CLI is installed (**Unconfirmed**: not run).

**Paths.** The handler serves `POST /a2a/booking`, `GET /a2a/booking/agent-card.json`, and `GET /.well-known/agent-card.json` unless `BOOKING_CARD_WELL_KNOWN=false` (set it when another agent on the site claims the well-known card). Anything else is 404.

**The card's origin is `PUBLIC_ORIGIN`, never the request's `Host`.** Behind CloudFront the function sees the Function URL's host (`<id>.lambda-url.<region>.on.aws`); a card built from it would send A2A clients around the site's CDN.

### Same origin (prefer this)

The site's CloudFront distribution routes the agent's paths to the Function URL, so the relay calls `/a2a/booking` on its own origin, as on every other host. Add one origin and two behaviors to the existing distribution, ahead of the default behavior:

```yaml
# In the site's AWS::CloudFront::Distribution DistributionConfig (or the console's equivalent)
Origins:
  - Id: booking-agent
    DomainName: <id>.lambda-url.<region>.on.aws     # the stack's FunctionUrl output, without https:// and the trailing /
    CustomOriginConfig:
      OriginProtocolPolicy: https-only
      OriginReadTimeout: 60                          # buffered: CloudFront waits for the whole turn (default 30)
CacheBehaviors:
  - PathPattern: /a2a/booking*                         # the endpoint and its card
    TargetOriginId: booking-agent
    ViewerProtocolPolicy: https-only
    AllowedMethods: [GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE]
    CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad          # Managed-CachingDisabled
    OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac  # Managed-AllViewerExceptHostHeader
  - PathPattern: /.well-known/agent-card.json        # only if no other agent claims it
    TargetOriginId: booking-agent
    ViewerProtocolPolicy: https-only
    CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad
    OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac
```

- **All viewer headers except `Host`.** The Function URL refuses a request whose `Host` isn't its own, and the `Authorization` header must reach the function. `AllViewerExceptHostHeader` does both
- **Caching disabled.** A POST is never cached, and a cached card outlives a change of origin
- **The relay's own origin.** The relay (agent-handoff) fetches `new URL('/a2a/booking', <its request's origin>)`. When the relay runs behind the same distribution, that is `https://example.com/a2a/booking`, through CloudFront

**Unconfirmed:** these behaviors have not been applied to a live distribution, and the managed policy IDs are AWS's published ones, not read from an account.

### Own origin (the alternative)

For a site whose CDN can't route a path to it — or a relay on another host — point the relay's target at the Function URL itself (`endpoint: 'https://<id>.lambda-url.<region>.on.aws/a2a/booking'`), or at a custom domain on its own CloudFront distribution. `PUBLIC_ORIGIN` is then that origin, so the card points at it. No CORS: only the relay, server to server, calls the endpoint. The site's `/.well-known/agent-card.json` stays wherever it is; serve this card there only by a redirect or copy the user chooses.

## 2. Where tasks and progress live

**DynamoDB**, one table, one key `pk` (string), `PAY_PER_REQUEST`:

| Item | Holds | Expires |
|---|---|---|
| `task#<id>` | The SDK's task, as its own JSON | 7 days |
| `progress#<id>` | agent-core's progress: the values, the offer, the summary awaiting a yes, the attempt. A completed task keeps only `submitted` and the reference | 7 days, or deleted when a task completes without booking |
| `sent#<id>.<attempt>` | The claim: created once per attempt, before the slot is re-checked and the sink is called | 30 days |

Every invocation may land on a different execution environment, so both stores live here — in memory, the "yes" arrives where the summary isn't, and nothing is sent. **Reads are strongly consistent** (`ConsistentRead: true`); DynamoDB's default is eventually consistent, and a "yes" read a moment after the summary was written could miss it. Items carry a `ttl` attribute (epoch seconds) and the table's TTL setting deletes them — DynamoDB TTL deletes within days of expiry, not on the second, which is fine for cleanup and is why nothing reads `ttl` as a deadline.

`progress.get` reads `progress#` alone. `submitted` is written only once the sink has answered, and a completed task keeps it with the reference, so an invocation that arrives after the booking answers "already been made" from the progress. (The quote agent's version also read `sent#`, since its claim and its "submitted" were one flag; here a claim is per attempt and can be spent with nothing booked, when the slot is gone at the yes.)

**Stale tasks.** A turn cut off by the timeout leaves its task `TASK_STATE_WORKING`. Before a `GetTask` or `SubscribeToTask`, the handler fails a task that has been working for more than 90 s (longer than the 45 s timeout).

## 3. The conditional write

Yes. `claim` is a `PutItem` of `sent#<id>.<attempt>` with `ConditionExpression: attribute_not_exists(pk)`. DynamoDB evaluates the condition and the write atomically, so of any number of concurrent invocations exactly one succeeds; the rest get `ConditionalCheckFailedException`, which `claim` returns as `false`. The same key goes to the sink as `Idempotency-Key`. Verified against DynamoDB Local: two "yes" invocations from two Node processes at once → one booking; 20 concurrent claims on one attempt → one true.

The losing invocation waits for the winner's answer (up to 8 s) and says "Your booking has already been made. Reference NB-…", or, if the winner found the slot gone, offers the same fresh slots. With no answer in time, it hands back `unresolved` with the business's phone — it never books again on a guess.

## 4. Where secrets live

**SSM Parameter Store, `SecureString`**, under one path (`BOOKING_SECRETS_PREFIX`, e.g. `/booking-agent/prod/`):

| Parameter | What |
|---|---|
| `<prefix>anthropic-api-key` | The model key. Missing: the agent is unavailable and the form takes bookings |
| `<prefix>a2a-relay-token` | The relay's bearer, shared with the relay's target credential. Missing: every POST is 403 |
| `<prefix>webhook-signing-secret` | Signs posts to the sink (`X-Nxis-Signature`) |
| `<prefix>availability-token` | Optional: the bearer for `BOOKING_AVAILABILITY_URL`, if the calendar endpoint wants one |

Read with one `GetParameters` call (`WithDecryption: true`) on the first request that needs them, cached in the execution environment for five minutes, so a rotated value takes effect within five minutes without a redeploy. Not Lambda environment variables: anyone with `lambda:GetFunctionConfiguration` reads those in plain text, and they appear in the console. SSM over Secrets Manager because standard SecureStrings cost nothing and three small values need no rotation lambdas; Secrets Manager works the same way if the account standardizes on it (`GetSecretValue`, `secretsmanager:GetSecretValue` on the secret's ARN).

CloudFormation cannot create SecureStrings, so the user creates them once, typing the value at the prompt rather than on the command line (shell history):

```bash
aws ssm put-parameter --name /booking-agent/prod/a2a-relay-token --type SecureString --value "$(openssl rand -hex 32)"
read -rs KEY && aws ssm put-parameter --name /booking-agent/prod/anthropic-api-key --type SecureString --value "$KEY"; unset KEY
```

**Least privilege** (in `template.yaml`): `dynamodb:GetItem`, `PutItem`, `DeleteItem` on this table only, and `ssm:GetParameters` on these four parameter ARNs only; the SAM transform adds `AWSLambdaBasicExecutionRole` for the logs. Under the AWS managed key `aws/ssm` no KMS grant is needed; under a customer managed key add `kms:Decrypt` on that key. On LocalStack the function called exactly `dynamodb:GetItem`, `dynamodb:PutItem` (with and without the condition) and `ssm:GetParameters` — all inside the policy; `DeleteItem` serves a cancel, which the run didn't send. **Unconfirmed:** LocalStack's community edition does not enforce IAM (`ENFORCE_IAM=1` is a Pro feature: a user with no policies still read the parameters), so the policy has not been exercised by an enforcer. An `AccessDenied` on AWS means a missing action, not a code bug.

`BOOKING_MODEL`, `PUBLIC_ORIGIN`, `BOOKING_SINK_URL`, `BOOKING_AVAILABILITY_URL` (the site's free-slot endpoint; unset, the agent is unavailable) and the table name are plain configuration, set as environment variables by the template. `.env.example` lists the names only.

**The relay's availability.** A relay in this same function can import `bookingAvailability`. A relay elsewhere (a Netlify function, a Node server) can't, so give it its own signal that the model key is configured — for a relay also on AWS, `ssm:GetParameter` on the key parameter without decryption is enough to know it exists. Without one, the relay offers `booking` while the agent hands every visitor back "can't take bookings right now".

## 5. How long one response may take

Up to the function's **45 s timeout**. A turn is one model call — capped at 15 s with one retry (`new Anthropic({ timeout, maxRetries: 1 })`) — and, on a yes, the sink, capped at 10 s. Two more limits sit in front:

- **CloudFront's origin read timeout** defaults to 30 s; raise it to 60 s on the `booking-agent` origin. In buffered mode CloudFront waits for the whole turn before the first byte
- **The relay's own host** (a Netlify function's ~10 s, say) bounds the relay's fetch. A slow turn there fails at the relay, not here

A sink that times out **after** the claim leaves the request possibly sent: the agent reports the failure and offers the form or phone, and never retries — agent-core's rule.

### Streaming vs buffered

The harness calls `SendStreamingMessage` and the card says `streaming: true`, but nothing needs the events as they happen: each turn publishes the task (working), then one status update — the question, the summary or the hand-back — and closes at input-required or completed, 2–4 s later. The relay passes a buffered `text/event-stream` body through untouched, and the harness reads a whole SSE body (or a single JSON response) the same way. So the function URL is **`InvokeMode: BUFFERED`**: the handler reads the core's `Response` to the end and returns it as one body. Verified locally: the turns' SSE bodies parse to the same task, states and hand-back.

Lambda response streaming (`awslambda.streamifyResponse` with `InvokeMode: RESPONSE_STREAM`) would deliver the "working" event first. It's not used: it adds a runtime-only global that a plain-Node check can't exercise, and a visitor sees no difference on a 2–4 s turn. **Unconfirmed** on Lambda either way.

### `@a2a-js/sdk` in a Lambda handler

Verified against `@a2a-js/sdk` 1.3.0 by reading its server code and by running it: `DefaultRequestHandler` and `JsonRpcTransportHandler` need no HTTP server — `bookingEndpoint` turns a web `Request` into a `Response`, and the handler converts the Function URL event to and from it. In the streaming path the SDK saves each event to the task store **before** yielding it, and the executor deletes progress before it finishes the bus, so by the time the response body is read to the end every write has landed — nothing is left running when Lambda freezes the environment. Two caveats, both harmless here: the SDK's per-task write lock and its event-bus manager are per process, so `SubscribeToTask` on another environment can't attach to a live turn (it reads the stored task, with the stale guard), and concurrent saves from two environments are last-write-wins — only the claim must be atomic, and it is.

## Deploy (the user runs these)

Nothing in this profile was deployed to AWS. When the user is ready, in the function's folder:

```bash
sam validate --lint
sam build
sam deploy --guided     # PublicOrigin, SecretsPrefix, BookingSinkUrl, BookingAvailabilityUrl; creates billable resources
```

Then the SecureStrings (section 4), the CloudFront behaviors above, the relay target's credential (the same token as `<prefix>a2a-relay-token`), and SKILL.md step 7 against the public origin.

## Verify

Locally, with Docker:

```bash
docker run -d --rm --name booking-ddb-local -p 127.0.0.1:8765:8000 amazon/dynamodb-local
DYNAMODB_ENDPOINT=http://127.0.0.1:8765 npx tsx local-check.ts
docker rm -f booking-ddb-local
```

`local-check.ts` refuses to run unless `DYNAMODB_ENDPOINT` is on localhost, sets dummy AWS credentials, and uses a scripted model (`useBookingAgent`) — never a real key.

Then the deployed shape on LocalStack, below.

After a deploy, SKILL.md step 7 on the public origin, plus:

| Check | Expect |
|---|---|
| `GET https://example.com/a2a/booking/agent-card.json` | `supportedInterfaces[0].url` is `https://example.com/a2a/booking`, not the Function URL |
| `POST` the Function URL directly, no token | 403 |
| The conversation to a yes, then the table | One `sent#<task>.0` item; one booking at the sink |
| CloudWatch Logs for the function | No key material: `aws logs filter-log-events --log-group-name /aws/lambda/<fn> --filter-pattern '"sk-ant"'` → nothing |
| `lambda get-function-configuration` | No secret among the environment variables |

## Try it on LocalStack

The quote agent's recipe, verified with LocalStack 4.2.1 community (`4.2.1.dev53`, the digest below), Docker Desktop on arm64; the booking agent's names and its availability URL are filled in, but this version has not been run there. **LocalStack 3.8.1 has no `nodejs22.x`** (its runtime map has it commented out). The run uses its own container, port and network; the stubs in `lambda/localstack/` stand in for the site's sink and the model — test values only, never a real key. In the function's folder (`handler.ts` with its imports fixed, the core, the adapter, `template.yaml`, and `localstack/`):

```bash
# 0. Never real AWS: test credentials, and --endpoint-url on every call
unset AWS_PROFILE AWS_SESSION_TOKEN
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
EP=http://127.0.0.1:4576

# 1. A network, the two stubs, LocalStack (kms: the table's SSESpecification creates a key)
docker network create booking-ls
docker run -d --name booking-ls-sink --network booking-ls -p 127.0.0.1:4577:4129 -v "$PWD/localstack:/s:ro" node:22-alpine node /s/stubs.mjs sink
docker run -d --name booking-ls-model --network booking-ls -v "$PWD/localstack:/s:ro" node:22-alpine node /s/stubs.mjs model
docker run -d --name booking-localstack --network booking-ls -p 127.0.0.1:4576:4566 \
  -e SERVICES=lambda,dynamodb,ssm,cloudformation,iam,sts,logs,s3,kms -e LAMBDA_DOCKER_NETWORK=booking-ls \
  -v /var/run/docker.sock:/var/run/docker.sock \
  localstack/localstack@sha256:bb4ef68912eba33cb0dc856939a46450b017c560932ebc17c119ccf54f26ce9c
until curl -sf $EP/_localstack/health >/dev/null; do sleep 1; done
aws sts get-caller-identity --endpoint-url $EP --query Account --output text   # must print 000000000000; stop otherwise

# 2. The SecureStrings, test values
aws ssm put-parameter --endpoint-url $EP --type SecureString --name /booking-agent/test/a2a-relay-token --value test-relay-token-0123456789abcdef
aws ssm put-parameter --endpoint-url $EP --type SecureString --name /booking-agent/test/webhook-signing-secret --value test-signing-secret
aws ssm put-parameter --endpoint-url $EP --type SecureString --name /booking-agent/test/anthropic-api-key --value test-model-key-not-real

# 3. Bundle as sam build does, upload, deploy the template with only CodeUri changed
npx esbuild handler.ts --bundle --platform=node --target=node22 --format=cjs --sourcemap --outfile=.ls/handler.js
(cd .ls && zip -q fn.zip handler.js handler.js.map)
aws s3 mb s3://booking-agent-artifacts --endpoint-url $EP
aws s3 cp .ls/fn.zip s3://booking-agent-artifacts/fn.zip --endpoint-url $EP
sed 's#^      CodeUri: \.$#      CodeUri: s3://booking-agent-artifacts/fn.zip#' template.yaml > .ls/packaged.yaml
aws cloudformation deploy --endpoint-url $EP --stack-name booking-agent --template-file .ls/packaged.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides PublicOrigin=https://northside.example SecretsPrefix=/booking-agent/test/ BookingSinkUrl=http://booking-ls-sink:4129/api/book BookingAvailabilityUrl=http://booking-ls-sink:4129/api/slots
res() { aws cloudformation describe-stack-resource --endpoint-url $EP --stack-name booking-agent --logical-resource-id $1 --query StackResourceDetail.PhysicalResourceId --output text; }
FN=$(res BookingFunction); TBL=$(res BookingTable)
URL=$(aws cloudformation describe-stacks --endpoint-url $EP --stack-name booking-agent --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text | sed 's#:4566/#:4576#')

# 4. LocalStack only: point the Anthropic SDK (ANTHROPIC_BASE_URL) at the model stub
aws lambda get-function-configuration --endpoint-url $EP --function-name $FN --query Environment --output json \
  | node -e 'const e = JSON.parse(require("fs").readFileSync(0)); e.Variables.ANTHROPIC_BASE_URL = "http://booking-ls-model:4130"; console.log(JSON.stringify(e))' > .ls/env.json
aws lambda update-function-configuration --endpoint-url $EP --function-name $FN --environment file://.ls/env.json

# 5. Drive it over HTTP: cards, 403, 413, the conversation, two "yes" at once
RELAY_TOKEN=test-relay-token-0123456789abcdef node localstack/drive.mjs "$URL"

# 6. The table, the logs, the environment
aws dynamodb scan --endpoint-url $EP --table-name $TBL --consistent-read --query 'Items[].[pk.S, ttl.N, json.S]' --output text
aws logs filter-log-events --endpoint-url $EP --log-group-name /aws/lambda/$FN --query 'events[].message' --output text \
  | grep -cE 'test-relay-token|test-model-key|test-signing-secret|pat@example'   # 0
aws lambda get-function-configuration --endpoint-url $EP --function-name $FN --query 'Environment.Variables'

# 7. Clean up: LocalStack's function containers outlive it
docker rm -fv booking-localstack booking-ls-sink booking-ls-model $(docker ps -aq --filter name=booking-localstack-lambda)
docker network rm booking-ls
docker rmi public.ecr.aws/lambda/nodejs:22   # pulled by LocalStack for the function
```

What it showed, for the quote agent:

| Check | Result |
|---|---|
| CloudFormation, SAM transform | `CREATE_COMPLETE`: table (PAY_PER_REQUEST, TTL on `ttl`, SSE), role (the inline policy and `AWSLambdaBasicExecutionRole`), function (`nodejs22.x`, arm64 image, 45 s, 512 MB), log group, Function URL (`AuthType: NONE`, buffered) and its public permission |
| Both cards over the Function URL | 200, `supportedInterfaces[0].url` `https://northside.example/a2a/booking`, not the Function URL |
| No token, a wrong token, 70 KB | 403, 403, 413 — the token read from SSM |
| Envelope → question → summary → yes | `TASK_STATE_COMPLETED`, resolved, the sink's reference; one post, signed with the SSM secret |
| Two "yes" at once, six rounds | One post per task; the other reply "already been sent" with the reference |
| The table afterwards | Per task: `task#`, `progress#`, one `sent#`. A completed task's `progress#` holds only `submitted` and `reference`; every item has `ttl` (7 days; `sent#` 30) |
| CloudWatch Logs | Only `START`/`END`/`REPORT` lines: no token, key, signing secret or visitor email |
| The function's environment | No secret: the prefix, never a value |

LocalStack notes — accommodations for the test, not changes to ship:

- **`ANTHROPIC_BASE_URL`** is added to the function only here, so the SDK reaches the stub. `@anthropic-ai/sdk` 1.x sends the key as `Authorization: Bearer`, which the stub accepts
- **The Function URL** comes back as `http://<id>.lambda-url.us-east-1.localhost.localstack.cloud:4566/`; `localhost.localstack.cloud` resolves to 127.0.0.1, so swap in the published port
- **`aws cloudformation package`** — don't, with an old AWS CLI. v2.1.x ignored `--endpoint-url` for its S3 upload and sent it to real S3 (refused, since the key was `test`), and ignores `AWS_ENDPOINT_URL`. Zip and `aws s3 cp` with the endpoint, as above
- **`--filter-pattern`** on `logs filter-log-events` is not applied by LocalStack (every event comes back); dump the messages and grep
- **IAM** is not enforced by the community edition, with or without `ENFORCE_IAM=1`

## Unconfirmed

- A deploy to AWS: `sam build` (SAM CLI was not installed; esbuild built the same bundle), `sam deploy`, and the Function URL on AWS
- The IAM policy under enforcement (LocalStack showed the calls the function makes; it doesn't deny any)
- CloudFront behaviors in front of the Function URL, `AllViewerExceptHostHeader` passing `Authorization`, the 60 s origin read timeout
- SSM SecureString reads under `aws/ssm` without a KMS grant (LocalStack's SSM doesn't go through KMS)
- A real model call from Lambda (the key, latency against the timeouts) and AWS cold starts
- `sam local start-api`
- Lambda response streaming (not used)
