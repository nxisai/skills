/**
 * page-config.ts — the page's half: the handoff target that takes the booking
 * form, and the prompt lines that send booking requests to it. Merge these into
 * wherever the site mounts the agent (agent.handoff, agent.systemPrompt).
 *
 * The same shape as the quote agent's (skills/quote-agent, page-config.ts), for
 * the same reasons: a prompt line alone does not route — asked "Book a visit",
 * the model calls the tool named for exactly that; hiding the form tool while
 * the prompt names it does not either; and an NxisAI app link to the form
 * (`?nxis_handoff=<the ScheduleAction or ReserveAction @id>`) forces a form
 * call the prompt never sees. `takes` (harness 0.12.0) handles all three in the
 * harness, and reports a resolved booking as the form's conversion.
 */
import type { HandoffTargetConfig } from '@nxisai/agent-harness';

/** The form's tool name: the ScheduleAction's (or ReserveAction's) `name`, sanitized (lower case, `_` for spaces and dashes). */
export const BOOKING_FORM_TOOL = 'book_a_visit';

export const BOOKING_TARGET = {
  kind: 'agent',
  // EXAMPLE: the label a visitor reads — the same name as the agent's card and the relay's label.
  label: 'Northside Booking',
  description: 'books a visit in conversation, from the free times on the calendar',
  // While the relay lists `booking` as available: the form tools are kept from the model, a call to
  // one becomes this handoff, an app link to the form starts it, and a resolved hand-back is
  // reported as the form sent. Unavailable: the form works exactly as before.
  takes: [BOOKING_FORM_TOOL],
} satisfies HandoffTargetConfig;

/** Merge `booking` into the site's existing `agent.handoff.targets`; the relay must list it too. */
export const PAGE_HANDOFF = {
  relay: '/api/handoff',
  targets: { booking: BOOKING_TARGET },
};

/**
 * Prompt lines, added to the site's system prompt. They name NO form tool:
 * a tool the prompt names gets called, even on a turn it was not offered.
 * "the booking form tool" is enough for the fallback; the harness offers it then.
 */
export const BOOKING_PROMPT_LINES = [
  'If they want to book or schedule a visit or an appointment, or ask when someone can come, call transfer_to_agent with target booking.',
  'Never say a time is free yourself. Only if transfer_to_agent does not offer booking, use the booking form tool instead.',
];
