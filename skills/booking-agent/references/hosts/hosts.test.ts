/**
 * hosts/hosts.test.ts — the vite profile's handler, driven over A2A as the
 * relay drives it (vitest, in one process). The model is a script, the
 * calendar is the in-memory example, and the sink is watched: no model call,
 * no network.
 *
 * The other profiles are checked by running them: hosts/docker.md,
 * cloudrun.md, cloudflare.md and lambda.md, "How to prove it", with
 * lambda/localstack/stubs.mjs and drive.mjs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAY_TOKEN, bookingA2A, bookingAvailability, useBookingAgent } from './vite';
import { exampleSite, memoryAvailability, memorySink } from '../example-site';
import type { BookingDecision, BookingModel } from '../agent-core';

const ORIGIN = 'http://localhost:5173';
const MONDAY_10AM = Date.parse('2026-11-09T16:00:00Z');
const pat = { full_name: 'Pat Kowalski', phone: '773-555-0100', email: 'pat@example.com', street: '5100 N Milwaukee Ave', zip: '60630' };

const scripted = (script: BookingDecision[]): BookingModel => ({
  async decide() {
    const next = script.shift();
    if (!next) throw new Error('The model was asked more often than the script allows.');
    return next;
  },
});

const envelope = {
  data: { handoff: 'envelope', reason: 'Booking', summary: 'Kitchen drain is slow.', page: { url: `${ORIGIN}/`, title: 'Northside Plumbing' } },
  mediaType: 'application/json',
  metadata: { extension: 'https://nxis.ai/a2a/handoff/v1' },
};

/** One relay call: the turn's server-sent events, read for the task, its last state and what the agent said. */
async function send(text: string | null, taskId?: string, contextId?: string) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'SendStreamingMessage',
    params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', ...(taskId ? { taskId, contextId } : {}), parts: text ? [{ text }] : [envelope] } },
  };
  const res = await bookingA2A(
    new Request(`${ORIGIN}/a2a/booking`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RELAY_TOKEN}`, 'content-type': 'application/json', accept: 'text/event-stream', 'a2a-version': '1.0' },
      body: JSON.stringify(body),
    }),
  );
  const turn: { status: number; taskId?: string; contextId?: string; state?: string; text: string; handback?: Record<string, unknown> } = { status: res.status, text: '' };
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const r = JSON.parse(line.slice(6)).result ?? {};
    const t = r.task ?? r.statusUpdate;
    if (!t) continue;
    turn.taskId ??= t.id ?? t.taskId;
    turn.contextId ??= t.contextId;
    turn.state = t.status?.state;
    const parts: { text?: string; data?: Record<string, unknown> }[] = t.status?.message?.parts ?? [];
    if (parts.length) {
      turn.text = parts.map((p) => p.text ?? '').join('');
      turn.handback = parts.find((p) => p.data?.handoff === 'handback')?.data;
    }
  }
  return turn;
}

afterEach(() => {
  vi.restoreAllMocks();
  useBookingAgent({ model: null, site: null });
});

describe('the vite profile', () => {
  it('books once over A2A, with the sink\'s reference', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const booked: string[] = [];
    const cal = memoryAvailability();
    useBookingAgent({
      model: scripted([
        { action: 'details', values: { service: 'drain-cleaning', date: '2026-11-10', part_of_day: 'morning' } },
        { action: 'details', values: { service: 'drain-cleaning', date: '2026-11-10', part_of_day: 'morning', ...pat } },
      ]),
      site: exampleSite({ availability: cal, sink: memorySink(cal, (_b, ref) => booked.push(ref)) }),
      now: () => MONDAY_10AM,
    });
    expect(await bookingAvailability()).toEqual({ available: true });

    const t1 = await send(null);
    expect(t1.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(t1.text).toContain('1. Tue, Nov 10, 8:00 – 10:00 AM CST');
    const t2 = await send('1', t1.taskId, t1.contextId);
    expect(t2.text).toBe('What name should the booking be under?');
    const t3 = await send('Pat Kowalski, 773-555-0100, pat@example.com, 5100 N Milwaukee Ave 60630', t1.taskId, t1.contextId);
    expect(t3.text).toMatch(/Shall I book it\?/);
    const t4 = await send('yes', t1.taskId, t1.contextId);
    expect(t4.state).toBe('TASK_STATE_COMPLETED');
    expect(booked).toHaveLength(1);
    expect(t4.handback).toEqual(expect.objectContaining({ outcome: 'resolved', references: [{ label: 'Booking reference', value: booked[0] }] }));
    const again = await send('yes', t1.taskId, t1.contextId);
    expect(booked).toHaveLength(1);
    expect(again.status).toBe(200);
  });

  it('is unavailable without a calendar, even with a model, and refuses a turn', async () => {
    useBookingAgent({ model: scripted([]), site: null });
    expect(await bookingAvailability()).toEqual({ available: false });
    expect((await send(null)).status).toBe(503);
  });

  it('refuses anything without the relay token, and serves the card on both paths', async () => {
    useBookingAgent({ model: scripted([]), site: exampleSite({ availability: memoryAvailability(), sink: memorySink(memoryAvailability()) }) });
    expect((await bookingA2A(new Request(`${ORIGIN}/a2a/booking`, { method: 'POST', body: '{}' }))).status).toBe(403);
    for (const path of ['/a2a/booking/agent-card.json', '/.well-known/agent-card.json']) {
      const card = (await (await bookingA2A(new Request(`${ORIGIN}${path}`))).json()) as { supportedInterfaces: { url: string }[] };
      expect(card.supportedInterfaces[0].url).toBe(`${ORIGIN}/a2a/booking`);
    }
  });
});
