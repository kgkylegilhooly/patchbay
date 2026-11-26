import { agentOf, type AgentKind } from './model'

/**
 * F29: a new agent is called "Claude" or "Codex" until it's renamed, so a canvas of them reads as a column of the same
 * word. The first thing it's asked names it instead, once, and only while it still has that default name.
 */

/** About as long as a window's header shows in full. */
const MAX_CHARS = 44

/** What a new agent is called: renderer/newNodes.ts and `patchbay open` without --title. */
export function defaultAgentTitle(agent: AgentKind): string {
  return agent === 'codex' ? 'Codex' : 'Claude'
}

export function hasDefaultTitle(n: { title: string; agent?: AgentKind }): boolean {
  return n.title === defaultAgentTitle(agentOf(n))
}

/** The brief after the team rules `patchbay open` puts before it (main/control/teamRules.ts). */
const BRIEF_AFTER_RULES = /^Team rules \(from the [^\n]*\n[\s\S]*?\n\nYour brief:\n/

/** A whole line Patchbay writes ahead of a message: "[Patchbay message from …]", "[Patchbay notice about …]". */
const PATCHBAY_HEADER = /^\s*\[Patchbay [^\n]*\]\s*$/

/** A title from a prompt's first line that says something, or null: a slash command, a tag or a word or two of nothing. */
export function titleFromPrompt(prompt: string): string | null {
  const text = prompt.replace(BRIEF_AFTER_RULES, '')
  for (const raw of text.split(/\r?\n/)) {
    // The line `patchbay send` puts first, saying which node a message is from (main/control/verbs.ts senderLine).
    if (PATCHBAY_HEADER.test(raw)) continue
    const line = raw
      .replace(/^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/, '')
      .replace(/[*_`]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'“‘](.*)["'”’]$/, '$1')
      .trim()
    if (!line) continue
    if (line.startsWith('/') || line.startsWith('<')) return null
    if (line.length < 3) return null
    return clip(line)
  }
  return null
}

function clip(line: string): string {
  if (line.length <= MAX_CHARS) return line
  const cut = line.slice(0, MAX_CHARS)
  const space = cut.lastIndexOf(' ')
  return `${(space > MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`
}
