/**
 * hosts/lambda/handler.ts — the Quote Agent as an AWS Lambda function (Node 22)
 * behind a Lambda Function URL, with tasks, progress and the submit-once claim
 * in DynamoDB and its secrets in SSM Parameter Store. See ../lambda.md.
 *
 * Put it beside agent-core.ts and the site adapter (fix the two imports), and
 * deploy it with template.yaml in this folder.
 *
 * Status: DRAFT — verified on LocalStack, not deployed to AWS. Deployed with
 * template.yaml to LocalStack 4.2.1 (nodejs22.x, Function URL, DynamoDB, SSM)
 * and driven over HTTP with a stub model API and a stub sink: both cards, 403
 * without the token, 413, a conversation to exactly one submission, two
 * concurrent "yes" → one submission with the reference in both replies. IAM
 * enforcement, the CloudFront routing, KMS behind SSM and the real model have
 * not run on AWS. Say so to the user, and run SKILL.md step 7 on the deployed
 * stack before relying on it.
 *
 *   POST /a2a/quote                    the A2A endpoint: only the relay calls it
 *   GET  /a2a/quote/agent-card.json    its Agent Card
 *   GET  /.well-known/agent-card.json  the same card — only if no other agent on
 *                                      the site claims it (QUOTE_CARD_WELL_KNOWN=false)
 *
 * Host answers:
 * - Server code: this function, behind its Function URL (AuthType NONE: the
 *   relay's bearer is the gate, checked here). The site's CloudFront routes
 *   /a2a/quote* and /.well-known/agent-card.json to it, so it is same-origin.
 *   Locally: a plain Node script that calls `handler` with Function URL events
 *   (local-check.ts), or `sam local start-api`.
 * - Where tasks live: DynamoDB, one table, key `pk`: `task#<id>` (the SDK's
 *   task), `progress#<id>` (agent-core's progress), `sent#<id>` (the claim).
 *   Reads are strongly consistent: the "yes" must see the summary the previous
 *   invocation wrote. Items carry a `ttl` attribute; DynamoDB TTL deletes them.
 * - Conditional write: yes. `claim` is a PutItem with
 *   `attribute_not_exists(pk)` — atomic across concurrent invocations.
 * - Secrets: SSM Parameter Store SecureStrings under QUOTE_SECRETS_PREFIX, read
 *   once per container and cached for five minutes. Never Lambda environment
 *   variables, which anyone with lambda:GetFunctionConfiguration can read.
 * - Response time: buffered. The whole turn — one model call and, on a yes, the
 *   sink — finishes before the response leaves; the function's timeout (45 s)
 *   and CloudFront's origin read timeout (raise it to 60 s) bound it. A turn cut
 *   off leaves its task "working"; the next read of it fails it.
 *
 * Needs @a2a-js/sdk, @anthropic-ai/sdk, @aws-sdk/client-dynamodb and
 * @aws-sdk/client-ssm (bundled by esbuild through `sam build`).
 */
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import { QuoteExecutor, claudeModel, quoteAgentCard, quoteEndpoint, type MessagesClient, type Progress, type ProgressStore, type QuoteModel, type QuoteSite } from '../../agent-core';
import { exampleSite, webhookSink } from '../../example-site';

const PATH = '/a2a/quote';
const CARD = `${PATH}/agent-card.json`;
const WELL_KNOWN = '/.well-known/agent-card.json';
/** A current Sonnet. Override with QUOTE_MODEL. */
export const DEFAULT_QUOTE_MODEL = 'claude-sonnet-5-5';
/** Longer than the function's timeout: a task working for longer was cut off. */
const STALE_WORKING_MS = 90_000;
/** Each part of a turn gives up well inside the function's 45 s. */
const MODEL_TIMEOUT_MS = 15_000;
const SINK_TIMEOUT_MS = 10_000;
const SECRETS_TTL_MS = 5 * 60_000;
const DAY = 86_400;

const env = (name: string) => process.env[name] || undefined;

/**
 * The public origin the site is served on, scheme included: the card points
 * here. Never the request's Host — behind CloudFront that is the Function URL.
 */
const publicOrigin = () => {
  const origin = env('PUBLIC_ORIGIN');
  if (!origin) throw new Error('PUBLIC_ORIGIN is not set.');
  return origin.replace(/\/+$/, '');
};

// ── Secrets: SSM Parameter Store SecureStrings, cached per container ────────

export interface Secrets {
  /** Unset: the agent is offered as unavailable, and the form takes quotes. */
  anthropicApiKey?: string;
  /** Shared with the relay (its target's credential). Unset: nothing may call the agent. */
  relayToken?: string;
  /** Signs the agent's posts to the sink, as the sink verifies them. */
  webhookSigningSecret?: string;
}

/** Parameter names under QUOTE_SECRETS_PREFIX ('/quote-agent/prod/'). */
const PARAMS = { anthropicApiKey: 'anthropic-api-key', relayToken: 'a2a-relay-token', webhookSigningSecret: 'webhook-signing-secret' } as const;

const ssm = new SSMClient({});
let cached: { at: number; secrets: Promise<Secrets> } | null = null;
/** Set by tests: secrets without SSM. */
let fixedSecrets: Secrets | null = null;

function secrets(): Promise<Secrets> {
  if (fixedSecrets) return Promise.resolve(fixedSecrets);
  if (cached && Date.now() - cached.at < SECRETS_TTL_MS) return cached.secrets;
  const prefix = env('QUOTE_SECRETS_PREFIX');
  const load = (async (): Promise<Secrets> => {
    if (!prefix) return {};
    const names = Object.values(PARAMS).map((p) => `${prefix}${p}`);
    const out = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
    const value = (p: string) => out.Parameters?.find((x) => x.Name === `${prefix}${p}`)?.Value || undefined;
    return { anthropicApiKey: value(PARAMS.anthropicApiKey), relayToken: value(PARAMS.relayToken), webhookSigningSecret: value(PARAMS.webhookSigningSecret) };
  })();
  cached = { at: Date.now(), secrets: load };
  // A failed read is not cached: the next request tries again.
  load.catch(() => {
    if (cached?.secrets === load) cached = null;
  });
  return load;
}

/** Constant-time, on digests so the lengths always match. */
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

// ── Tasks, progress and the claim in DynamoDB ───────────────────────────────

const ddb = new DynamoDBClient(env('DYNAMODB_ENDPOINT') ? { endpoint: env('DYNAMODB_ENDPOINT') } : {});
const table = () => {
  const name = env('QUOTE_TABLE');
  if (!name) throw new Error('QUOTE_TABLE is not set.');
  return name;
};
const expires = (days: number) => ({ N: String(Math.floor(Date.now() / 1000) + days * DAY) });

async function getJSON<T>(pk: string): Promise<T | null> {
  // Strongly consistent: a turn must see what the previous invocation wrote.
  const out = await ddb.send(new GetItemCommand({ TableName: table(), Key: { pk: { S: pk } }, ConsistentRead: true }));
  const json = out.Item?.json?.S;
  return json ? (JSON.parse(json) as T) : null;
}

async function putJSON(pk: string, value: unknown, days = 7): Promise<void> {
  await ddb.send(new PutItemCommand({ TableName: table(), Item: { pk: { S: pk }, json: { S: JSON.stringify(value) }, ttl: expires(days) } }));
}

/** The SDK's tasks, in its own JSON. */
const taskStore: TaskStore = {
  save: (task) => putJSON(`task#${task.id}`, SdkTask.toJSON(task)),
  async load(taskId) {
    const json = await getJSON(`task#${taskId}`);
    return json ? SdkTask.fromJSON(json) : undefined;
  },
  // Each task belongs to one visitor; the relay never forwards ListTasks.
  async list() {
    return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
  },
};

/** Exported for local-check.ts. */
export const progressStore: ProgressStore = {
  /**
   * The progress, marked submitted when the task's claim exists: a late
   * invocation that reads after the winner deleted its progress still answers
   * "already sent" rather than starting over.
   */
  async get(id) {
    const [progress, sent] = await Promise.all([getJSON<Progress>(`progress#${id}`), getJSON(`sent#${id}`)]);
    return sent ? { ...progress, submitted: true } : progress;
  },
  set: (id, p) => putJSON(`progress#${id}`, p),
  async delete(id) {
    await ddb.send(new DeleteItemCommand({ TableName: table(), Key: { pk: { S: `progress#${id}` } } }));
  },
  /**
   * The single-submit guarantee: a `sent#` item only the first claim can
   * create. DynamoDB evaluates the condition atomically, so of any number of
   * concurrent invocations exactly one gets true. Kept 30 days, longer than the task.
   */
  async claim(id) {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: table(),
          Item: { pk: { S: `sent#${id}` }, json: { S: JSON.stringify({ at: new Date().toISOString() }) }, ttl: expires(30) },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  },
};

/** Fail a task a timed-out turn left working, so a resubscribing client learns it is over. */
async function settleStale(taskId: string): Promise<void> {
  const json = await getJSON<{ status?: { state?: string; timestamp?: string } }>(`task#${taskId}`);
  const status = json?.status;
  if (status?.state !== 'TASK_STATE_WORKING' || !status.timestamp) return;
  if (Date.now() - Date.parse(status.timestamp) < STALE_WORKING_MS) return;
  await putJSON(`task#${taskId}`, {
    ...json,
    status: {
      state: 'TASK_STATE_FAILED',
      timestamp: new Date().toISOString(),
      message: { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: "Sorry — that took too long. The site's quote form still works." }] },
    },
  });
}

// ── The agent ───────────────────────────────────────────────────────────────

/** EXAMPLE: the card's words. The name matches QuoteSite.agentName and the relay's label. */
const card = (origin: string) =>
  quoteAgentCard({
    origin,
    path: PATH,
    name: 'Ridgeline Quotes',
    description:
      'Takes a roofing quote or estimate request in conversation — asks one question at a time, confirms the details with the visitor, sends it to Ridgeline Roofing, and returns a quote reference.',
    organization: 'Ridgeline Roofing',
    collects:
      "Collects the visitor's name, email, optional phone, the service, the timeline and a description of the job, confirms them with the visitor, sends them as the site's quote form would, and returns a quote reference.",
    examples: ['Can I get a quote for a new roof?', 'How much would it cost to replace my gutters?'],
  });

/** A fetch that gives up, so a slow sink can't run the function out of time. */
const sinkFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(SINK_TIMEOUT_MS) });

// EXAMPLE sink: the endpoint the site's form posts to, fixed server-side (QUOTE_SINK_URL, not a
// secret). For a form whose handler saves to the site's own database, use appSink instead.
let signingSecret: string | undefined;
const defaultSite = () =>
  exampleSite({
    sink: webhookSink({
      url: () => env('QUOTE_SINK_URL') ?? `${publicOrigin()}/api/quote`,
      get secret() {
        return signingSecret;
      },
      fetch: sinkFetch,
    }),
  });

/** Tests: a scripted model (or none), a site whose sink they watch, and secrets without SSM. */
let testModel: { model: QuoteModel | null } | null = null;
let site: QuoteSite | null = null;
export function useQuoteAgent(opts: { model: QuoteModel | null; site?: QuoteSite; secrets: Secrets }): void {
  testModel = { model: opts.model };
  if (opts.site) site = opts.site;
  fixedSecrets = opts.secrets;
  handle = null;
}

let model: { key: string; model: QuoteModel } | null = null;
const modelFor = (key: string | undefined): QuoteModel | null => {
  if (testModel) return testModel.model;
  if (!key) return null;
  if (model?.key !== key) {
    const client = new Anthropic({ apiKey: key, timeout: MODEL_TIMEOUT_MS, maxRetries: 1 });
    model = { key, model: claudeModel(client as unknown as MessagesClient, env('QUOTE_MODEL') ?? DEFAULT_QUOTE_MODEL) };
  }
  return model.model;
};

/**
 * Whether it can take a handoff now: only with a model key. A relay in this
 * same function imports it as the target's `availability`; a relay elsewhere
 * reads the same parameter (see ../lambda.md).
 */
export const quoteAvailability = async () => ({ available: modelFor((await secrets()).anthropicApiKey) !== null });

let current: Secrets = {};
let handle: ((req: Request) => Promise<Response>) | null = null;

function endpoint() {
  handle ??= quoteEndpoint({
    card: card(publicOrigin()),
    executor: new QuoteExecutor((site ??= defaultSite()), () => modelFor(current.anthropicApiKey), progressStore),
    tasks: taskStore,
    // No default: with no token configured, nothing may call the agent.
    fromRelay: (req) => {
      const token = current.relayToken;
      const sent = req.headers.get('authorization') ?? '';
      return !!token && same(sent, `Bearer ${token}`);
    },
    beforeRead: settleStale,
  });
  return handle;
}

// ── Function URL events as web Request → Response ───────────────────────────

const json = (status: number, body: unknown, cache = 'no-store'): APIGatewayProxyStructuredResultV2 => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  body: JSON.stringify(body),
});

function toRequest(event: LambdaFunctionURLEvent): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  const method = event.requestContext.http.method;
  const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  return new Request(`${publicOrigin()}${event.rawPath}${query}`, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
}

/**
 * Buffered: the response — JSON, or the turn's server-sent events in one body —
 * is read whole before it is returned. The relay and the harness read either.
 */
async function toResult(res: Response): Promise<LambdaFunctionURLResult> {
  return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const wellKnown = env('QUOTE_CARD_WELL_KNOWN') !== 'false';
  try {
    if (method === 'GET' && (path === CARD || (wellKnown && path === WELL_KNOWN))) {
      return json(200, card(publicOrigin()), 'public, max-age=300');
    }
    if (path !== PATH) return json(404, { error: 'Not found.' });
    try {
      current = await secrets();
      signingSecret = current.webhookSigningSecret;
    } catch (err) {
      console.error('[quote] secrets unavailable:', err instanceof Error ? err.name : err);
      return json(503, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Not available right now.' } });
    }
    return await toResult(await endpoint()(toRequest(event)));
  } catch (err) {
    console.error('[quote] failed:', err);
    return json(500, { error: 'quote failed.' });
  }
}
