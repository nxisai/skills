/**
 * page-config.ts — the page's half: the handoff target that takes the quote
 * form, and the prompt lines that send quote requests to it. Merge these into
 * wherever the site mounts the agent (agent.handoff, agent.systemPrompt).
 *
 * Why it is shaped like this — each was tried first, and failed:
 *
 * - A prompt line alone ("for a quote, call transfer_to_agent with target
 *   quote") did not route quotes. Asked "Get a quote from McManus Electric",
 *   the model called `quote_form_anywhere`, a tool named for exactly that.
 * - Hiding the form tools from the turn did not either, while the prompt still
 *   named one: the model called it by name anyway, and the harness runs a call
 *   against every tool on the page, not only the ones the turn offered.
 * - The NxisAI app's "Get a quote on their page" link (`?nxis_handoff=<the
 *   QuoteAction @id>`) opened the form with a forced call, so the model never
 *   chose and no routing in the prompt or the provider applied.
 *
 * `takes` (harness 0.12.0) does all three in the harness itself, and reports a
 * resolved quote as the form's conversion with the link's report token, which
 * page-side workarounds dropped. Do not rebuild any of it in the page.
 */
import type { HandoffTargetConfig } from '@nxisai/agent-harness';

/** The form's tool name: the QuoteAction's `name`, sanitized (lower case, `_` for spaces and dashes). */
export const QUOTE_FORM_TOOL = 'quote_form';

export const QUOTE_TARGET = {
  kind: 'agent',
  // EXAMPLE: the label a visitor reads — the same name as the agent's card and the relay's label.
  label: 'Ridgeline Quotes',
  description: 'takes a quote or estimate request in conversation and sends it',
  // While the relay lists `quote` as available: the form tools are kept from the model, a call to
  // one becomes this handoff, an app link to the form starts it, and a resolved hand-back is
  // reported as the form sent. Unavailable: the form works exactly as before.
  takes: [QUOTE_FORM_TOOL],
} satisfies HandoffTargetConfig;

/** Merge `quote` into the site's existing `agent.handoff.targets`; the relay must list it too. */
export const PAGE_HANDOFF = {
  relay: '/api/handoff',
  targets: { quote: QUOTE_TARGET },
};

/**
 * Prompt lines, added to the site's system prompt. They name NO form tool:
 * a tool the prompt names gets called, even on a turn it was not offered.
 * "the quote form tool" is enough for the fallback; the harness offers it then.
 */
export const QUOTE_PROMPT_LINES = [
  'If they ask for a quote, an estimate, or what a job would cost, call transfer_to_agent with target quote.',
  'Only if transfer_to_agent does not offer quote, use the quote form tool instead.',
];
