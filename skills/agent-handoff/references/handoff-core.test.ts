/**
 * handoff-core.test.ts — what the relay keeps of a visitor's details (vitest).
 *
 * A handoff envelope's `contact` may carry everything the visitor left (name,
 * email, phone, street, city, ZIP) so the target doesn't ask again. The
 * relay's 30-day record keeps less: the email address for every target, so a
 * visitor's request finds their records, and for a person target also the
 * phone and name, so the team can reply. Never the address.
 *
 * Copy it beside handoff-core.ts and fix the import if the project put the
 * core elsewhere. It needs no network: the targets are a fake fetch.
 */
import { describe, expect, it } from "vitest";
import { handleHandoff, keptRecord, type HandoffRecord, type RelayOptions, type RelayStore, type RelayTarget } from "./handoff-core";

const ORIGIN = "http://localhost:5173";
const ALL = { name: "Dana Reyes", email: "dana@example.com", phone: "312 555 0100", street: "1 Main St", city: "Chicago", zip: "60607" };

function record(over: Partial<HandoffRecord> = {}): HandoffRecord {
  return { target: "team", taskId: "task-1", key: "k", createdAt: new Date(0).toISOString(), lastSeen: 0, ...over };
}

function memoryStore(): RelayStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(k: string) => (data.has(k) ? (structuredClone(data.get(k)) as T) : null),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    delete: async (k) => void data.delete(k),
    list: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)),
  };
}

const targets: RelayTarget[] = [
  { name: "quote", kind: "agent", label: "Quotes", endpoint: "/a2a/quote", transcript: false, push: false },
  { name: "team", kind: "person", label: "Our team", endpoint: "/a2a/desk", transcript: false, push: true },
];

/** A target that answers every SendMessage with a new task. */
const fakeFetch = (async () =>
  Response.json({ jsonrpc: "2.0", id: 1, result: { task: { id: "task-1", contextId: "ctx-1" } } })) as unknown as typeof fetch;

async function handOff(target: string, contact: Record<string, string>) {
  const store = memoryStore();
  const opts: RelayOptions = { targets, store, allowedOrigins: [ORIGIN], pushUrl: `${ORIGIN}/api/handoff-push`, fetch: fakeFetch };
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: {
      message: {
        messageId: "m-1",
        role: "ROLE_USER",
        parts: [{ text: "I'd like a quote." }, { data: { handoff: "envelope", reason: "a quote", contact, page: { url: `${ORIGIN}/` } } }],
      },
    },
  };
  const res = await handleHandoff(
    new Request(`${ORIGIN}/api/handoff/${target}`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    target,
    opts,
  );
  expect(res.status).toBe(200);
  return store.get<HandoffRecord>("task:task-1");
}

describe("keptRecord", () => {
  it("keeps only the email address for an agent target", () => {
    const kept = keptRecord(record({ target: "quote", contact: ALL }), "agent");
    expect(kept.contact).toEqual({ email: "dana@example.com" });
    expect(kept).toMatchObject({ target: "quote", taskId: "task-1" });
  });

  it("keeps the email, phone and name for a person target, and nothing of the address", () => {
    expect(keptRecord(record({ contact: ALL }), "person").contact).toEqual({ email: "dana@example.com", phone: "312 555 0100", name: "Dana Reyes" });
  });

  it("treats an unknown kind as an agent's", () => {
    expect(keptRecord(record({ contact: ALL }), undefined).contact).toEqual({ email: "dana@example.com" });
  });

  it("drops blank values, values that aren't strings, and a contact with nothing left", () => {
    expect(keptRecord(record({ contact: { email: "", phone: "312 555 0100", name: 7 } as never }), "person").contact).toEqual({ phone: "312 555 0100" });
    expect(keptRecord(record({ contact: { street: "1 Main St" } as never }), "person")).not.toHaveProperty("contact");
    expect(keptRecord(record({ contact: { name: "Dana", street: "1 Main St" } as never }), "agent")).not.toHaveProperty("contact");
  });

  it("leaves a record without a contact as it is", () => {
    const r = record();
    expect(keptRecord(r, "person")).toBe(r);
  });
});

describe("the record a handoff leaves", () => {
  it("to an agent target holds the email address alone", async () => {
    const kept = await handOff("quote", ALL);
    expect(kept?.contact).toEqual({ email: "dana@example.com" });
    expect(kept).toMatchObject({ target: "quote", taskId: "task-1", contextId: "ctx-1", reason: "a quote", page: { url: `${ORIGIN}/` } });
  });

  it("to a person target holds the email, phone and name", async () => {
    const kept = await handOff("team", ALL);
    expect(kept?.contact).toEqual({ email: "dana@example.com", phone: "312 555 0100", name: "Dana Reyes" });
    expect(JSON.stringify(kept)).not.toMatch(/Main St|Chicago|60607/);
  });

  it("without an email address keeps no contact for an agent target", async () => {
    const kept = await handOff("quote", { name: "Dana Reyes", street: "1 Main St" });
    expect(kept).not.toHaveProperty("contact");
  });
});
