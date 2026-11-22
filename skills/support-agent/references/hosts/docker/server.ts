/**
 * hosts/docker/server.ts — the Support Agent as a container of its own: one
 * long-running Node process, tasks and context in its memory, reported turns in
 * a JSON Lines file on a mounted volume.
 *
 * Status: see hosts/docker.md. In the project this sits beside node-server.ts,
 * support-core.ts and the site adapter, so its imports are './node-server',
 * './support-core' and './site'.
 *
 * ONE REPLICA. Tasks and context are in this process's memory: a second
 * replica behind a balancer sends a follow-up to a process that never saw the
 * first turn ("please ask again", and the thumbs on the answer do nothing). For
 * more than one, use the cloudrun profile's server and Firestore store, which
 * run anywhere with credentials, or a store of your own behind TaskStore and
 * ContextStore.
 *
 * Environment (read once, at startup — see .env.example):
 *   A2A_RELAY_TOKEN       required, 32+ characters: the bearer token the relay sends
 *   PUBLIC_ORIGIN         required: the site's origin, as the card points at it
 *   SUPPORT_MCP_ENDPOINT  required: the site's MCP server, fixed here
 *   ANTHROPIC_API_KEY     unset (and no SUPPORT_MODEL_BASE_URL): offered as unavailable
 *   SUPPORT_MODEL, SUPPORT_REWRITE_MODEL, SUPPORT_MODEL_BASE_URL   as in SKILL.md step 3
 *   SUPPORT_GAP_KEY, SUPPORT_PROVISIONING_ENDPOINT   both, or no gap reports
 *   SUPPORT_TURN_REF_SECRET   32+ characters: question keys and turn references. Unset: no gap or close reports
 *   SUPPORT_TURN_STORE    the questions and turns file: /data/turns.jsonl in the image, on the volume
 *   SUPPORT_CARD_WELL_KNOWN   "false" when another agent serves /.well-known/agent-card.json
 *   SUPPORT_REPORT_WAIT_MS   how long a response is held for its gap reports. Default 5000
 *   SUPPORT_SHUTDOWN_MS   how long SIGTERM waits for turns and reports. Default 8000
 *   PORT                  default 4130
 * Each secret may instead come from a file named by <NAME>_FILE (a Docker secret).
 */
import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import { gapSinkFromEnv, mcpRecords, memoryContext } from '../../support-core';
import { exampleSite, turnStoreFromEnv } from '../../example-site';
import { exitOnSignal, modelFromEnv, relayToken, reportsLine, required, secret, supportNodeHost } from './node-server';

const PORT = Number(process.env.PORT ?? 4130);
const GRACE_MS = Number(process.env.SUPPORT_SHUTDOWN_MS ?? 8_000);

const env = process.env;
const { model, name: modelName } = modelFromEnv(env);
const site = exampleSite({
  records: mcpRecords({ endpoint: required('SUPPORT_MCP_ENDPOINT', env.SUPPORT_MCP_ENDPOINT) }),
  gaps: gapSinkFromEnv({ SUPPORT_GAP_KEY: secret('SUPPORT_GAP_KEY'), SUPPORT_PROVISIONING_ENDPOINT: env.SUPPORT_PROVISIONING_ENDPOINT }),
  // The JSON Lines file, on the volume mounted at /data (SUPPORT_TURN_STORE in the Dockerfile).
  ...turnStoreFromEnv({ SUPPORT_TURN_REF_SECRET: secret('SUPPORT_TURN_REF_SECRET'), SUPPORT_TURN_STORE: env.SUPPORT_TURN_STORE }),
});

const host = supportNodeHost({
  site,
  model,
  modelName,
  tasks: new InMemoryTaskStore(),
  context: memoryContext(),
  store: { name: 'memory', ping: async () => {} },
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

// 0.0.0.0 inside the container: compose publishes the port on loopback only.
host.server.listen(PORT, '0.0.0.0', () => {
  console.info(
    `[support] Support Agent on :${PORT} — model: ${modelName ?? 'none (no ANTHROPIC_API_KEY), so offered as unavailable'}; store: memory (one replica only); ${reportsLine(site)}`,
  );
});

exitOnSignal(host, GRACE_MS);
