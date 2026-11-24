/**
 * The handoff relay, host-neutral: `Request` in, `Response` out.
 *
 * The on-page agent (@nxisai/agent-harness, `agent.handoff = { relay, targets }`)
 * never talks to a handoff target directly. It sends A2A 1.0 JSON-RPC here,
 * naming the target; this checks it, forwards it with the site's credential,
 * and passes the answer — JSON, or server-sent events — straight back. The
 * contract is the harness's docs/handoff.md.
 *
 *   GET  <relay>          the targets, and whether each is available now
 *   POST <relay>/<name>   an A2A request for that target
 *   POST <push path>      A2A push notifications from targets (handlePush)
 *
 * A host adapter supplies the storage, the allowed origins, the targets and
 * the host's own rate limit. Everything else is here.
 */

export const A2A_VERSION = "1.0";
export const HANDOFF_EXTENSION = "https://nxis.ai/a2a/handoff/v1";
export const KEY_HEADER = "Nxis-Handoff-Key";

const METHODS = new Set(["SendMessage", "SendStreamingMessage", "GetTask", "CancelTask", "SubscribeToTask"]);
const MAX_BODY = 64_000;
const RETENTION_MS = 30 * 24 * 3600_000;
/** A visitor seen more recently than this still has the conversation open. */
const PRESENT_MS = 45_000;

/** Somewhere to keep handoff records. */
export interface RelayStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface RelayTarget {
  /** The name the page and the relay know it by. */
  name: string;
  kind: "agent" | "person";
  label: string;
  description?: string;
  /** Its A2A endpoint: a path on this site, or an absolute URL. */
  endpoint: string;
  /** Headers proving the relay to the target: `{ Authorization: "Bearer …" }`. From a secret, never from the page. */
  credential?: () => Record<string, string>;
  /** Whether the visitor's recent turns may be shared with it. */
  transcript: boolean;
  /** Whether it sends A2A push notifications (a desk with people behind it). */
  push: boolean;
  /** Whether it can take a handoff now; absent means always. */
  availability?: () => Promise<{ available: boolean; hours?: string; queueLength?: number; waitMinutes?: number | null }>;
}

export interface RelayOptions {
  targets: RelayTarget[];
  store: RelayStore;
  /** Full origins, scheme and port included, as a browser sends them. */
  allowedOrigins: readonly string[];
  /** Where push notifications should be sent, absolute. */
  pushUrl?: string;
  /** Reach a visitor who has left: called with a person's reply. Return true once sent. */
  notify?: (to: string, reply: string, record: HandoffRecord) => Promise<boolean>;
  fetch?: typeof fetch;
}

export interface HandoffRecord {
  target: string;
  taskId: string;
  contextId?: string;
  key: string;
  pushToken?: string;
  reason?: string;
  consent?: unknown;
  /** What `keptRecord` keeps of the envelope's `contact`: the email, and for a person target the phone and name. */
  contact?: { email?: string; phone?: string; name?: string };
  page?: { url?: string; title?: string };
  createdAt: string;
  lastSeen: number;
  emailed?: string[];
}

/**
 * A handoff record as kept: the visitor's email address, so a request from them finds their records by it (and a
 * person can reply to it after they have gone); for a person target also the phone and name they left. Nothing else
 * of the envelope's `contact`: an agent target may be sent the visitor's full details (a street, city and ZIP code
 * among them) for the conversation it has with them, but those are the agent's to use while it lasts, not the
 * relay's to keep for 30 days. Blank values and any other field are dropped; a contact with nothing left goes.
 */
export function keptRecord(r: HandoffRecord, kind: "agent" | "person" | undefined): HandoffRecord {
  if (!r.contact) return r;
  const { contact, ...rest } = r;
  const keys = kind === "person" ? (["email", "phone", "name"] as const) : (["email"] as const);
  const kept = Object.fromEntries(keys.filter((k) => typeof contact[k] === "string" && contact[k]).map((k) => [k, contact[k]]));
  return Object.keys(kept).length ? { ...rest, contact: kept } : rest;
}

interface Part {
  text?: string;
  data?: unknown;
}
interface Message {
  messageId: string;
  role: string;
  parts: Part[];
  taskId?: string;
}

const refuse = (status: number, error: string) => Response.json({ error }, { status });

function extension(parts: Part[] = [], kind: string): Record<string, unknown> | null {
  for (const p of parts) {
    const d = p.data as Record<string, unknown> | undefined;
    if (d && typeof d === "object" && d.handoff === kind) return d;
  }
  return null;
}

/** GET <relay> and POST <relay>/<name>. `rest` is the path after the relay's own. */
export async function handleHandoff(req: Request, rest: string, opts: RelayOptions): Promise<Response> {
  if (req.method === "GET" && !rest) return listTargets(opts);
  if (req.method !== "POST" || !rest) return refuse(405, "Method not allowed.");

  const origin = req.headers.get("origin");
  if (!origin || !opts.allowedOrigins.includes(origin)) return refuse(403, "Not permitted from this origin.");
  const target = opts.targets.find((t) => t.name === decodeURIComponent(rest));
  if (!target) return refuse(404, "No such handoff target.");

  const raw = await req.text();
  if (raw.length > MAX_BODY) return refuse(413, "Request too large.");
  let rpc: { jsonrpc?: string; method?: string; params?: Record<string, unknown> };
  try {
    rpc = JSON.parse(raw);
  } catch {
    return refuse(400, "Body must be JSON.");
  }
  if (rpc.jsonrpc !== "2.0" || !rpc.method || !METHODS.has(rpc.method)) return refuse(400, "Not an A2A request this relay forwards.");
  const params = (rpc.params ??= {});
  const message = params.message as Message | undefined;
  const taskId = message?.taskId ?? (typeof params.id === "string" ? params.id : undefined);

  // A request about an existing task must come from the browser that started it.
  let key = req.headers.get(KEY_HEADER) ?? "";
  if (taskId) {
    const record = await opts.store.get<HandoffRecord>(`task:${taskId}`);
    if (!record || record.target !== target.name || !key || record.key !== key) {
      return refuse(403, "This conversation belongs to another visitor.");
    }
    await opts.store.set(`task:${taskId}`, { ...record, lastSeen: Date.now() });
  } else if (rpc.method === "SendMessage" || rpc.method === "SendStreamingMessage") {
    if (target.availability) {
      const { available } = await target.availability();
      const email = (extension(message?.parts, "envelope")?.contact as { email?: string } | undefined)?.email;
      if (!available && !email) return refuse(409, `${target.label} is away now. Leave an email address and they'll reply there.`);
    }
    key = crypto.randomUUID();
  } else {
    return refuse(400, "Which task?");
  }

  let pushToken: string | undefined;
  if (!taskId && target.push && opts.pushUrl) {
    pushToken = crypto.randomUUID();
    const configuration = ((params.configuration as Record<string, unknown>) ??= {});
    configuration.taskPushNotificationConfig = {
      url: opts.pushUrl,
      token: pushToken,
      authentication: { scheme: "Bearer", credentials: pushToken },
    };
  }

  let upstream: Response;
  try {
    upstream = await (opts.fetch ?? fetch)(new URL(target.endpoint, new URL(req.url).origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: rpc.method === "SendStreamingMessage" || rpc.method === "SubscribeToTask" ? "text/event-stream" : "application/json",
        "A2A-Version": A2A_VERSION,
        "A2A-Extensions": HANDOFF_EXTENSION,
        ...target.credential?.(),
      },
      body: JSON.stringify(rpc),
    });
  } catch (err) {
    console.error(`[handoff] ${target.name} unreachable:`, err);
    return refuse(502, `${target.label} can't be reached right now.`);
  }

  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-cache",
  };
  if (!taskId) headers[KEY_HEADER] = key;

  const remember = taskId
    ? undefined
    : async (task: { id: string; contextId?: string }) => {
        const envelope = extension(message?.parts, "envelope") ?? {};
        const record: HandoffRecord = {
          target: target.name,
          taskId: task.id,
          contextId: task.contextId,
          key,
          pushToken,
          reason: envelope.reason as string | undefined,
          consent: envelope.consent,
          contact: envelope.contact as HandoffRecord["contact"],
          page: envelope.page as HandoffRecord["page"],
          createdAt: new Date().toISOString(),
          lastSeen: Date.now(),
        };
        await opts.store.set(`task:${task.id}`, keptRecord(record, target.kind));
        if (pushToken) await opts.store.set(`push:${pushToken}`, { taskId: task.id });
      };

  if (!upstream.body || !headers["Content-Type"].includes("text/event-stream")) {
    const body = await upstream.text();
    if (remember) {
      try {
        const id = (JSON.parse(body) as { result?: { task?: { id: string; contextId?: string } } }).result?.task;
        if (id?.id) await remember(id);
      } catch {
        // Not JSON; passed on as it came.
      }
    }
    return new Response(body, { status: upstream.status, headers });
  }
  return new Response(remember ? watch(upstream.body, remember) : upstream.body, {
    status: upstream.status,
    headers: { ...headers, "X-Accel-Buffering": "no" },
  });
}

/** Pass a stream through untouched, noting the task it names once. */
function watch(body: ReadableStream<Uint8Array>, found: (task: { id: string; contextId?: string }) => Promise<void>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        controller.enqueue(chunk);
        if (done) return;
        buffer += decoder.decode(chunk, { stream: true });
        for (const line of buffer.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          try {
            const r = (JSON.parse(line.slice(5)) as { result?: Record<string, { id?: string; taskId?: string; contextId?: string }> }).result;
            const t = r?.task ?? r?.statusUpdate ?? r?.artifactUpdate;
            const id = t?.id ?? t?.taskId;
            if (id) {
              done = true;
              await found({ id, contextId: t?.contextId });
              break;
            }
          } catch {
            // A partial line: wait for the rest.
          }
        }
        if (!done) buffer = buffer.slice(Math.max(0, buffer.lastIndexOf("\n")));
      },
    }),
  );
}

async function listTargets(opts: RelayOptions): Promise<Response> {
  const targets = await Promise.all(
    opts.targets.map(async (t) => ({
      name: t.name,
      kind: t.kind,
      label: t.label,
      description: t.description,
      transcript: t.transcript,
      ...(t.availability ? await t.availability().catch(() => ({ available: false })) : { available: true }),
    })),
  );
  void prune(opts.store);
  return Response.json({ targets }, { headers: { "Cache-Control": "no-store" } });
}

async function prune(store: RelayStore): Promise<void> {
  try {
    for (const k of await store.list("task:")) {
      const r = await store.get<HandoffRecord>(k);
      if (r && Date.now() - Date.parse(r.createdAt) > RETENTION_MS) {
        await store.delete(k);
        if (r.pushToken) await store.delete(`push:${r.pushToken}`);
      }
    }
  } catch (err) {
    console.warn("[handoff] prune failed:", err);
  }
}

/** A target's push notification: reach a visitor who has left, if they asked to be. */
export async function handlePush(req: Request, opts: RelayOptions): Promise<Response> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const pointer = token ? await opts.store.get<{ taskId: string }>(`push:${token}`) : null;
  if (!pointer) return new Response(null, { status: 204 });
  const record = await opts.store.get<HandoffRecord>(`task:${pointer.taskId}`);
  if (!record || record.pushToken !== token) return new Response(null, { status: 204 });

  const event = (await req.json().catch(() => null)) as { statusUpdate?: { status?: { message?: Message } } } | null;
  const message = event?.statusUpdate?.status?.message;
  const text = message?.role === "ROLE_AGENT" ? message.parts.map((p) => p.text ?? "").join("\n").trim() : "";
  const to = record.contact?.email;
  if (text && to && opts.notify && Date.now() - record.lastSeen > PRESENT_MS && !record.emailed?.includes(message!.messageId)) {
    if (await opts.notify(to, text, record)) {
      await opts.store.set(`task:${record.taskId}`, { ...record, emailed: [...(record.emailed ?? []), message!.messageId] });
    }
  }
  return new Response(null, { status: 204 });
}
