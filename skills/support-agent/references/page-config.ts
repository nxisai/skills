/**
 * page-config.ts — the page's half: the `support` handoff target, a person
 * target for escalation, and the three prompt lines. Merge these into
 * wherever the site mounts the agent (agent.handoff, agent.systemPrompt).
 *
 * There is no `takes`: the site's contact or support form stays with the
 * on-page agent. The Support Agent hands back instead, and the prompt
 * lines tell the on-page model what to do with each hand-back.
 */
import type { HandoffTargetConfig } from '@nxisai/agent-harness';

export const SUPPORT_TARGET = {
  kind: 'agent',
  // EXAMPLE: the label a visitor reads — the same name as the agent's card and the relay's label.
  label: 'Ridgeline Help',
  description: 'answers how-to and product questions from our help content, with sources',
} satisfies HandoffTargetConfig;

/** EXAMPLE: the site's person target, from agent-handoff. Escalation reaches a person through it. */
export const TEAM_TARGET = {
  kind: 'person',
  label: 'Our team',
  description: 'a person at the office',
} satisfies HandoffTargetConfig;

/** Merge `support` into the site's existing `agent.handoff.targets`; the relay must list it too. */
export const PAGE_HANDOFF = {
  relay: '/api/handoff',
  targets: { support: SUPPORT_TARGET, team: TEAM_TARGET },
};

/**
 * Prompt lines, added to the site's system prompt. They name no form tool. With
 * `agent.agents`, `transfer_to_agent` goes in the slice that handles questions,
 * and `talk_to_a_person` in every slice.
 */
export const SUPPORT_PROMPT_LINES = [
  'If they ask how to do something, how something works, or how to fix a problem with one of our products or services, call transfer_to_agent with target support.',
  'If a hand-back says the visitor wants a person, call talk_to_a_person with the summary it gives.',
  'If a hand-back says the visitor wants a quote, a booking or to contact us, carry on as if they had asked you.',
];
