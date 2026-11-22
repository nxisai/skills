/**
 * hosts/docker/redis-store.ts — tasks and progress in Redis, for more than one
 * replica of the Booking Agent's container.
 *
 * One replica keeps both in memory (the SDK's InMemoryTaskStore and
 * agent-core's memoryProgress()). Two or more behind one reverse proxy need a
 * store every replica sees, or the visitor's "yes" lands on a replica that
 * never showed them the summary — and nothing is sent, or worse, each replica
 * keeps its own "submitted" flag.
 *
 *   booking:task:<id>       the SDK's task, in its own JSON           (TTL: a day)
 *   booking:progress:<id>   agent-core's Progress                     (TTL: a day)
 *   booking:sent:<task>.<n> the claim per attempt: SET NX, so only   (TTL: a week)
 *                         one replica ever calls the sink for it
 *
 * Redis down is a refusal, not a fallback. Commands fail at once
 * (`disableOfflineQueue`) rather than queueing, so a turn that needs the store
 * fails — the visitor is offered the form — and nothing is sent. Falling back
 * to memory would bring back exactly the double submit the claim is for. The
 * client reconnects on its own, and the next turn works.
 */
import { createClient } from 'redis';
import { Task as SdkTask } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';
import type { Progress, ProgressStore } from '../../agent-core';

export type Redis = ReturnType<typeof createClient>;

const CONNECT_TIMEOUT_MS = 2_000;
const DAY = 24 * 60 * 60;
/** Longer than any single turn takes; a task working for longer was cut off (a replica stopped mid-turn). */
const STALE_WORKING_MS = 90_000;

/**
 * Connect, or fail within two seconds. The redis client retries a failed
 * connection indefinitely, so `connect()` alone never rejects and the server
 * would hang at startup; it is raced against a timeout here. Once connected,
 * a dropped connection is retried in the background with backoff.
 */
export async function connectRedis(url: string): Promise<Redis> {
  const client = createClient({
    url,
    // While disconnected, a command rejects at once instead of waiting in a queue.
    disableOfflineQueue: true,
    socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5_000) },
  });
  // Required: without a listener, a connection error is an unhandled 'error' event and takes the process down.
  client.on('error', (err: Error) => console.warn('[booking] redis:', err.message));
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('connect timed out')), CONNECT_TIMEOUT_MS)),
    ]);
    return client;
  } catch (err) {
    await client.disconnect().catch(() => {});
    throw err;
  }
}

/** The SDK's tasks and agent-core's progress, both in Redis. */
export function redisStores(redis: Redis, prefix = 'booking:'): { tasks: TaskStore; progress: ProgressStore; failStale: (taskId: string) => Promise<void> } {
  const key = (kind: string, id: string) => `${prefix}${kind}:${id}`;

  const tasks: TaskStore = {
    async save(task) {
      await redis.set(key('task', task.id), JSON.stringify(SdkTask.toJSON(task)), { EX: DAY });
    },
    async load(taskId) {
      const json = await redis.get(key('task', taskId));
      return json ? SdkTask.fromJSON(JSON.parse(json)) : undefined;
    },
    // Each task belongs to one visitor; the relay never forwards ListTasks.
    async list() {
      return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
    },
  };

  const progress: ProgressStore = {
    async get(id) {
      const json = await redis.get(key('progress', id));
      return json ? (JSON.parse(json) as Progress) : null;
    },
    async set(id, p) {
      await redis.set(key('progress', id), JSON.stringify(p), { EX: DAY });
    },
    async delete(id) {
      await redis.del(key('progress', id));
    },
    /**
     * The single-submit guarantee across replicas: a `sent:` key only the
     * first claim can create. If Redis is unreachable this throws, the turn
     * fails, and nothing is sent. If the SET landed but its reply was lost,
     * the task reads as sent without having been — the safe side of the race.
     */
    async claim(id) {
      return (await redis.set(key('sent', id), String(Date.now()), { NX: true, EX: 7 * DAY })) === 'OK';
    },
  };

  /**
   * Fail a task a stopped replica left working, so a resubscribing relay
   * learns it is over instead of waiting on a turn no replica is running.
   * The endpoint's `beforeRead`.
   */
  async function failStale(taskId: string): Promise<void> {
    const raw = await redis.get(key('task', taskId));
    const json = raw ? (JSON.parse(raw) as { status?: { state?: string; timestamp?: string } }) : null;
    const status = json?.status;
    if (status?.state !== 'TASK_STATE_WORKING' || !status.timestamp) return;
    if (Date.now() - Date.parse(status.timestamp) < STALE_WORKING_MS) return;
    const failed = {
      ...json,
      status: {
        state: 'TASK_STATE_FAILED',
        timestamp: new Date().toISOString(),
        message: { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: "Sorry — that took too long. The site's booking form still works." }] },
      },
    };
    await redis.set(key('task', taskId), JSON.stringify(failed), { EX: DAY });
  }

  return { tasks, progress, failStale };
}
