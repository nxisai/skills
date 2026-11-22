/**
 * hosts/test-fakes.ts — what the host tests share: a corpus that finds nothing, a scripted model,
 * a slow gap sink, the host's own store in memory, and a relay's first message.
 */
import { HANDOFF_EXTENSION, type GapReport, type GapSink, type SupportModel, type SupportRecords, type TurnRecord, type TurnStore } from '../support-core';

const ORIGIN = 'https://help.example';

/** A help corpus that finds nothing: every question is a not-found, and a gap. */
export const emptyRecords: SupportRecords = {
  query: async () => [],
  get: async () => null,
  listTypes: async () => ['FAQPage', 'HowTo'],
};

/** The rewrite is the question itself, its last line out of the delimited block; compose, if asked, finds nothing. */
export const notFoundModel: SupportModel = {
  rewrite: async ({ messages }) => (messages.filter((m) => m.role === 'user').pop()?.content ?? '').replace(/<\/?visitor_message>/g, '').trim().split('\n').pop() ?? '',
  compose: async () => ({ kind: 'not_found', searched: '' }),
};

/** A gap sink that keeps every report, taking `delay(report)` milliseconds over each. */
export function slowSink(delay: (r: GapReport) => number) {
  const reports: { report: GapReport; at: number }[] = [];
  const sink: GapSink = {
    report: (report) => new Promise((r) => setTimeout(() => r(reports.push({ report, at: Date.now() })), delay(report))),
  };
  return { sink, reports };
}

/** The host's own store, in memory: the turns by ref and the questions' wording by key. Never sent anywhere. */
export function memoryTurnStore() {
  const turns = new Map<string, TurnRecord>();
  const questions = new Map<string, string>();
  const store: TurnStore = {
    save: async (ref, turn) => void turns.set(ref, turn),
    saveQuestion: async (key, q) => void questions.set(key, q.question),
  };
  return { store, turns, questions };
}

/**
 * A handoff summary that only asks to be connected. A handoff's first turn is greeted when it finds nothing (it carries
 * the on-page assistant's summary, not the visitor's own question), so a not-found and its gap report come from the
 * visitor's next turn: `followUpMessage`.
 */
export const CONNECT_ONLY = 'The visitor would like to talk to support.';

/** A SendStreamingMessage on a task already started: the visitor's next message, with no envelope. */
export function followUpMessage(taskId: string, text: string, id = 2) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'SendStreamingMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', taskId, parts: [{ text }] } } });
}

/** A SendStreamingMessage as the relay sends it: the visitor's text and the handoff envelope. */
export function streamingMessage(text: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendStreamingMessage',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text }, { data: { handoff: 'envelope', reason: text, locale: 'en', ui: { cards: 1 }, page: { url: `${ORIGIN}/help` } }, mediaType: 'application/json', metadata: { extension: HANDOFF_EXTENSION } }],
      },
    },
  });
}

