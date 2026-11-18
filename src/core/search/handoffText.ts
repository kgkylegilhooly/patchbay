import { AGENT_NAMES, type AgentKind } from '../../shared/model'
import type { HandoffDraft, HandoffSection } from './types'

/**
 * A handoff as text. Pure and free of Node, so the window can use it for Copy as Markdown and main for the prompt.
 */

/** The launch limit is 28000 characters, and the prompt's own lines need some of it. */
export const MAX_HANDOFF_CHARS = 24000

export const EXTRACTED_NOTE = 'Extracted from the conversation by Patchbay, without AI. Missing and stale evidence is marked, not filled in.'

/** A date and time in this PC's time zone, the same way everywhere a handoff shows one. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function handoffMarkdown(title: string, sections: Pick<HandoffSection, 'title' | 'text'>[]): string {
  return [`# Handoff: ${title}`, '', `_${EXTRACTED_NOTE} Then edited by the person._`, '', ...sections.flatMap((s) => [`## ${s.title}`, '', s.text.trim() || '(empty)', ''])].join('\n')
}

/** What the next agent is started with: the person's edited handoff, said to be one. */
export function handoffPrompt(draft: Pick<HandoffDraft, 'sourceTitle' | 'agent'>, sections: Pick<HandoffSection, 'title' | 'text'>[], nextAgent: AgentKind): string {
  return [
    `Continue the work from an earlier ${AGENT_NAMES[draft.agent]} conversation, "${draft.sourceTitle}". I prepared this handoff from that conversation and reviewed it before starting you${nextAgent === draft.agent ? '' : ` in ${AGENT_NAMES[nextAgent]}`}.`,
    'Parts of it were extracted automatically. Anything marked [Missing: …] or [Stale: …] was not confirmed. Check the current state of the files before relying on it, and tell me if it is wrong.',
    '',
    handoffMarkdown(draft.sourceTitle, sections)
  ].join('\n')
}
