/**
 * hosts/cloudrun/firestore-store.ts — the Support Agent's tasks, context and
 * reported turns in Firestore (Native mode), for Cloud Run.
 *
 * Cloud Run starts and stops instances on its own and sends any request to any
 * of them, and an instance's files go when it does. So nothing can stay in
 * memory or on disk: a follow-up landing on another instance must find the
 * context its first turn left (the offer of a person, the last answers for
 * their 👍/👎). Firestore is the default because it is serverless, billed per
 * operation with a free daily quota, needs no VPC path, deletes old documents
 * itself (TTL policies), and its reads are strongly consistent: a follow-up
 * always reads what the turn before it wrote.
 *
 *   support-tasks/<task id>     the SDK's task, as JSON               (expireAt: a day)
 *   support-context/<task id>   support-core's SupportContext, as JSON (expireAt: a day)
 *   support-turns/<ref>         a reported turn: prompt, reply, …     (expireAt: the owner's retention)
 *
 * The task and context are written before the turn's final event, so before
 * the response ends (cloudrun.md, "CPU"). A turn is saved just before its gap
 * report, which the server holds the response open for.
 *
 * Firestore unreachable is a refusal, not a fallback: every call is bounded (the
 * client's own retries run for minutes), so a turn that needs the store ends in
 * an error within seconds, and /healthz says why.
 */
import { randomUUID } from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
// In the project, beside support-core.ts: './support-core'.
import type { ContextStore, StoredGapQuestion, SupportContext, TurnRecord, TurnStore } from '../../support-core';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longer than any single turn takes; a task working for longer was cut off (an instance stopped mid-turn, or the request timed out). */
export const STALE_WORKING_MS = 90_000;
/** One Firestore call, normally tens of milliseconds from the same region. Past this the turn fails rather than waits. */
const OP_TIMEOUT_MS = 4_000;

/** The slice of the client this uses, so tests can pass a fake. */
export type FirestoreDb = Pick<Firestore, 'collection'>;

/**
 * The client. On Cloud Run the project and credentials come from the runtime service account;
 * locally, FIRESTORE_EMULATOR_HOST and GOOGLE_CLOUD_PROJECT point it at the emulator. gRPC, not
 * `preferRest`: the quote-agent profile found the REST transport ignoring the emulator.
 */
export async function firestoreClient(databaseId = process.env.FIRESTORE_DATABASE || '(default)'): Promise<Firestore> {
  const { Firestore } = await import('@google-cloud/firestore');
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

export interface FirestoreStores {
  tasks: TaskStore;
  context: ContextStore;
  /** Reported turns, one document per ref, and gap questions' wording, one document per question key. */
  turns: TurnStore;
  /** The endpoint's `beforeRead`: fail a task a cut-off turn left working. */
  failStale(taskId: string): Promise<void>;
  /** One read of a document that never exists: throws when Firestore can't be reached or read. */
  ping(): Promise<void>;
}

/**
 * The stores. `turnRetentionDays` is what the owner said when asked how long to keep turns (SKILL.md
 * step 3); a TTL policy on `expireAt` deletes them about then.
 */
export function firestoreStores(db: FirestoreDb, o: { prefix?: string; turnRetentionDays?: number } = {}): FirestoreStores {
  const prefix = o.prefix ?? 'support-';
  const tasksCol = db.collection(`${prefix}tasks`);
  const contextCol = db.collection(`${prefix}context`);
  const turnsCol = db.collection(`${prefix}turns`);
  const questionsCol = db.collection(`${prefix}questions`);
  const turnMs = (o.turnRetentionDays ?? 30) * DAY_MS;

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

  const context: ContextStore = {
    async get(id) {
      const snap = await bounded(contextCol.doc(id).get(), 'context get');
      const json = snap.get('json') as string | undefined;
      return json ? (JSON.parse(json) as SupportContext) : null;
    },
    async set(id, c) {
      await bounded(contextCol.doc(id).set({ json: JSON.stringify(c), expireAt: expireAt(DAY_MS) }), 'context set');
    },
    async delete(id) {
      await bounded(contextCol.doc(id).delete(), 'context delete');
    },
  };

  // The ref is the document id: the owner opens support-turns/<ref> for a gap's ref. The same turn
  // reported twice (a not-found, then a person asked for) writes the same document again.
  const turns: TurnStore = {
    async save(ref, turn: TurnRecord) {
      await bounded(turnsCol.doc(ref).set({ ...turn, expireAt: expireAt(turnMs) }), 'turn save');
    },
    // The key is the document id: the owner opens support-questions/<question_key> for a gap. Asked
    // again, the same document: firstSeen stays, lastSeen and the expiry move on.
    async saveQuestion(key, q) {
      const doc = questionsCol.doc(key);
      const first = (await bounded(doc.get(), 'question get')).get('firstSeen') as string | undefined;
      await bounded(doc.set({ question: q.question, firstSeen: first ?? q.at, lastSeen: q.at, expireAt: expireAt(turnMs) }), 'question save');
    },
  };

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
        message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Sorry, that took too long. Please ask again.' }] },
      },
    };
    await bounded(tasksCol.doc(taskId).set({ json: JSON.stringify(failed), expireAt: expireAt(DAY_MS) }), 'stale fail');
  }

  /** PERMISSION_DENIED here means the runtime service account lacks roles/datastore.user on this database. */
  async function ping(): Promise<void> {
    await bounded(tasksCol.doc('_healthz').get(), 'ping', 1_500);
  }

  return { tasks, context, turns, failStale, ping };
}

/** The turn a gap's ref names, or null: for the owner's look-up (step 8), with the same client. */
export async function findTurnIn(db: FirestoreDb, ref: string, prefix = 'support-'): Promise<(TurnRecord & { ref: string }) | null> {
  const snap = await db.collection(`${prefix}turns`).doc(ref).get();
  if (!snap.exists) return null;
  const { expireAt: _expire, ...turn } = snap.data() as TurnRecord & { expireAt?: unknown };
  return { ref, ...turn };
}

/** The wording a gap's `question_key` names, or null: for the owner's look-up (step 8), with the same client. */
export async function findGapQuestionIn(db: FirestoreDb, key: string, prefix = 'support-'): Promise<StoredGapQuestion | null> {
  const snap = await db.collection(`${prefix}questions`).doc(key).get();
  if (!snap.exists) return null;
  const { question, firstSeen, lastSeen } = snap.data() as Omit<StoredGapQuestion, 'key'>;
  return { key, question, firstSeen, lastSeen };
}
