/**
 * hosts/cloudrun/firestore-store.ts — tasks, progress and the submit claim in
 * Firestore (Native mode), for the Quote Agent on Cloud Run.
 *
 * Cloud Run starts and stops instances on its own, and any request may land on
 * any of them, so memory is never enough: the visitor's "yes" would land on an
 * instance that never showed them the summary. Firestore is the default store
 * because it is serverless — billed per operation, nothing running while no one
 * asks for a quote — where Memorystore Redis is an always-on instance with a
 * monthly floor and a VPC path to it (redis-store.ts still works; see
 * cloudrun.md).
 *
 *   quote-tasks/<id>      the SDK's task, as JSON                   (expireAt: a day)
 *   quote-progress/<id>   agent-core's Progress, as JSON            (expireAt: a day)
 *   quote-sent/<id>       the claim: created with create(), which   (expireAt: a week)
 *                         fails if the document exists, so only one
 *                         instance ever gets to call the sink
 *
 * `expireAt` is for a Firestore TTL policy on each collection group; TTL deletes
 * within about a day of the time, and nothing here relies on when.
 *
 * Firestore unreachable is a refusal, not a fallback. Every call is bounded by
 * a timeout (the client's own retries run for up to ten minutes), so a turn that
 * needs the store fails within seconds, the visitor is offered the form, and
 * nothing is sent.
 */
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
// In the project, beside agent-core.ts: './agent-core'.
import type { Progress, ProgressStore } from '../../agent-core';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longer than any single turn takes; a task working for longer was cut off (an instance stopped mid-turn, or the request timed out). */
const STALE_WORKING_MS = 90_000;
/** One Firestore call, normally tens of milliseconds from the same region. Past this the turn fails rather than waits. */
const OP_TIMEOUT_MS = 4_000;
/** gRPC ALREADY_EXISTS: create() on a document that exists. */
const ALREADY_EXISTS = 6;

/**
 * The client. On Cloud Run the project and credentials come from the runtime
 * service account; locally, FIRESTORE_EMULATOR_HOST and GOOGLE_CLOUD_PROJECT
 * point it at the emulator.
 *
 * Not `preferRest: true`, though it would skip loading gRPC on a cold start:
 * with @google-cloud/firestore 9.4 the REST transport ignores the emulator's
 * credentials, looks for real ones, and rejects outside any promise the caller
 * holds — which takes the process down. gRPC is what was verified.
 */
export function firestoreClient(databaseId = process.env.FIRESTORE_DATABASE || '(default)'): Firestore {
  return new Firestore({ databaseId });
}

/** Fail a call that takes longer than `ms`, rather than letting the client retry for minutes. */
function bounded<T>(op: Promise<T>, what: string, ms = OP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    op,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`firestore ${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const expireAt = (ms: number) => new Date(Date.now() + ms);

/** The SDK's tasks and agent-core's progress, both in Firestore. */
export function firestoreStores(
  db: Firestore,
  prefix = 'quote-',
): { tasks: TaskStore; progress: ProgressStore; failStale: (taskId: string) => Promise<void>; ping: () => Promise<void> } {
  const tasksCol = db.collection(`${prefix}tasks`);
  const progressCol = db.collection(`${prefix}progress`);
  const sentCol = db.collection(`${prefix}sent`);

  const tasks: TaskStore = {
    async save(task) {
      await bounded(tasksCol.doc(task.id).set({ json: JSON.stringify(SdkTask.toJSON(task)), expireAt: expireAt(DAY_MS) }), 'task save');
    },
    async load(taskId) {
      const snap = await bounded(tasksCol.doc(taskId).get(), 'task load');
      const json = snap.get('json') as string | undefined;
      return json ? SdkTask.fromJSON(JSON.parse(json)) : undefined;
    },
    // Each task belongs to one visitor; the relay never forwards ListTasks.
    async list() {
      return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
    },
  };

  const progress: ProgressStore = {
    async get(id) {
      const snap = await bounded(progressCol.doc(id).get(), 'progress get');
      const json = snap.get('json') as string | undefined;
      return json ? (JSON.parse(json) as Progress) : null;
    },
    async set(id, p) {
      await bounded(progressCol.doc(id).set({ json: JSON.stringify(p), expireAt: expireAt(DAY_MS) }), 'progress set');
    },
    async delete(id) {
      await bounded(progressCol.doc(id).delete(), 'progress delete');
    },
    /**
     * The single-submit guarantee across instances: create() writes the
     * document only if it does not exist, atomically, on the server.
     *
     * The client retries a commit that failed UNAVAILABLE. If the first attempt
     * landed and only its reply was lost, the retry finds the document — our
     * own. The `by` nonce tells that apart from another instance's claim, so a
     * lost reply neither sends twice nor tells the visitor "already sent" when
     * nothing was. If Firestore is unreachable this throws, the turn fails, and
     * nothing is sent; if the claim lands after the timeout, the task reads as
     * sent without having been — the safe side of the race.
     */
    async claim(id) {
      const by = randomUUID();
      const ref = sentCol.doc(id);
      try {
        await bounded(ref.create({ at: new Date(), by, expireAt: expireAt(7 * DAY_MS) }), 'claim');
        return true;
      } catch (err) {
        if ((err as { code?: unknown }).code !== ALREADY_EXISTS) throw err;
        const snap = await bounded(ref.get(), 'claim check');
        return snap.get('by') === by;
      }
    },
  };

  /**
   * Fail a task a stopped instance or a timed-out request left working, so a
   * resubscribing relay learns it is over instead of waiting on a turn no
   * instance is running. The endpoint's `beforeRead`.
   */
  async function failStale(taskId: string): Promise<void> {
    const snap = await bounded(tasksCol.doc(taskId).get(), 'stale check');
    const raw = snap.get('json') as string | undefined;
    const json = raw ? (JSON.parse(raw) as { status?: { state?: string; timestamp?: string } }) : null;
    const status = json?.status;
    if (status?.state !== 'TASK_STATE_WORKING' || !status.timestamp) return;
    if (Date.now() - Date.parse(status.timestamp) < STALE_WORKING_MS) return;
    const failed = {
      ...json,
      status: {
        state: 'TASK_STATE_FAILED',
        timestamp: new Date().toISOString(),
        message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: "Sorry — that took too long. The site's quote form still works." }] },
      },
    };
    await bounded(tasksCol.doc(taskId).set({ json: JSON.stringify(failed), expireAt: expireAt(DAY_MS) }), 'stale fail');
  }

  /**
   * Whether Firestore answers: one read of a document that never exists. It is
   * billed as one read, so the server caches the answer for a few seconds.
   * PERMISSION_DENIED here means the runtime service account lacks
   * roles/datastore.user on this database.
   */
  async function ping(): Promise<void> {
    await bounded(sentCol.doc('_healthz').get(), 'ping', 1_500);
  }

  return { tasks, progress, failStale, ping };
}
