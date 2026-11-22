/**
 * hosts/cloudrun/server.ts — the Support Agent on Google Cloud Run: the docker
 * profile's node:http server (hosts/docker/node-server.ts) with tasks, context
 * and reported turns in Firestore. Built with the docker profile's Dockerfile,
 * unchanged.
 *
 * Status: see hosts/cloudrun.md. In the project this sits beside
 * node-server.ts, firestore-store.ts, support-core.ts and the site adapter, so
 * its imports are './node-server', './firestore-store', './support-core' and
 * './site'.
 *
 * Differences from hosts/docker/server.ts, each marked CLOUD RUN:
 * - Never memory, never a file: Firestore for tasks, context and turns.
 * - The stale-task guard (`beforeRead`): a turn cut off by the request timeout
 *   or an instance stopped mid-turn leaves its task "working"; the next read
 *   fails it, on any instance.
 * - The Firestore client opens at startup, while the startup probe waits.
 *
 * CPU: request-based billing (the default) gives an instance CPU only while a
 * request is open. Every write a turn depends on lands before its final event,
 * and the server holds the response open for that turn's gap reports (at most
 * SUPPORT_REPORT_WAIT_MS), so nothing runs after the response ends.
 *
 * Environment (read once, at startup):
 *   A2A_RELAY_TOKEN, ANTHROPIC_API_KEY, SUPPORT_GAP_KEY, SUPPORT_TURN_REF_SECRET
 *                         secrets, from Secret Manager (as variables, or files via <NAME>_FILE)
 *   PUBLIC_ORIGIN, SUPPORT_MCP_ENDPOINT, SUPPORT_PROVISIONING_ENDPOINT   plain, required but the last
 *   SUPPORT_MODEL, SUPPORT_REWRITE_MODEL, SUPPORT_MODEL_BASE_URL         plain, as on docker
 *   FIRESTORE_DATABASE    default "(default)"
 *   SUPPORT_TURN_RETENTION_DAYS   how long reported questions and turns are kept: what the owner said. Default 30
 *   SUPPORT_REPORT_WAIT_MS   how long a response is held for its gap reports. Default 5000
 *   SUPPORT_SHUTDOWN_MS   default 8000: Cloud Run sends SIGKILL ten seconds after SIGTERM
 *   PORT                  set by Cloud Run from --port
 */
import { gapSinkFromEnv, mcpRecords } from '../../support-core';
import { exampleSite, turnStoreFromEnv } from '../../example-site';
import { exitOnSignal, modelFromEnv, relayToken, reportsLine, required, secret, supportNodeHost } from '../docker/node-server';
import { firestoreClient, firestoreStores } from './firestore-store';

const PORT = Number(process.env.PORT ?? 4130);
const GRACE_MS = Number(process.env.SUPPORT_SHUTDOWN_MS ?? 8_000);

const env = process.env;
const { model, name: modelName } = modelFromEnv(env);

// CLOUD RUN: Firestore, never memory or a file. Opened now, not on a visitor's turn.
const db = await firestoreClient();
const stores = firestoreStores(db, { turnRetentionDays: Number(env.SUPPORT_TURN_RETENTION_DAYS ?? 30) });

// The secret's checks (32+ characters) are turnStoreFromEnv's; the questions and turns go to Firestore, not its file.
const { turnRefSecret } = turnStoreFromEnv({ SUPPORT_TURN_REF_SECRET: secret('SUPPORT_TURN_REF_SECRET') });
const site = exampleSite({
  records: mcpRecords({ endpoint: required('SUPPORT_MCP_ENDPOINT', env.SUPPORT_MCP_ENDPOINT) }),
  gaps: gapSinkFromEnv({ SUPPORT_GAP_KEY: secret('SUPPORT_GAP_KEY'), SUPPORT_PROVISIONING_ENDPOINT: env.SUPPORT_PROVISIONING_ENDPOINT }),
  turns: turnRefSecret ? stores.turns : null,
  turnRefSecret,
});

const host = supportNodeHost({
  site,
  model,
  modelName,
  tasks: stores.tasks,
  context: stores.context,
  store: { name: 'firestore', ping: stores.ping },
  beforeRead: stores.failStale,
  relayToken: relayToken(env),
  publicOrigin: new URL(required('PUBLIC_ORIGIN', env.PUBLIC_ORIGIN)).origin,
  wellKnown: env.SUPPORT_CARD_WELL_KNOWN !== 'false',
  reportWaitMs: Number(env.SUPPORT_REPORT_WAIT_MS ?? 5_000),
  // EXAMPLE: the card's words. The name matches SupportSite.agentName and the relay's label.
  card: {
    name: 'Ridgeline Help',
    description: "Answers questions about Ridgeline Air's purifiers from Ridgeline's own help content — FAQs, guides, articles and videos — with a source for every answer.",
    organization: 'Ridgeline Air',
    examples: ['How do I replace the filter on the X200?', 'What does the warranty cover?'],
    tags: ['support', 'help', 'air purifier'],
  },
});

// 0.0.0.0: Cloud Run sends requests to the container's port on every interface.
host.server.listen(PORT, '0.0.0.0', () => {
  console.info(
    `[support] Support Agent on :${PORT} — model: ${modelName ?? 'none (no ANTHROPIC_API_KEY), so offered as unavailable'}; store: firestore; ${reportsLine(site)}`,
  );
  // CLOUD RUN: warm the client and the corpus check while the startup probe waits. Failures are only logged; /healthz says them.
  void host.health();
});

exitOnSignal(host, GRACE_MS, () => db.terminate());
