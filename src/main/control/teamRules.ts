import type { CanvasNode, StickyNode } from '../../shared/model'

/** A note with this title, in any case, holds the rules `open-agent` and `spawn-team` put before every brief. */
export const TEAM_RULES_TITLE = 'Team rules'

export interface TeamRules {
  id: string
  text: string
}

/**
 * The caller's project's Team rules note: one the person made, or one the caller made itself. A note another agent
 * made is skipped, so a member can't write rules into the briefs of agents it never opened.
 */
export function findTeamRules(nodes: readonly CanvasNode[], caller: CanvasNode): TeamRules | null {
  const title = TEAM_RULES_TITLE.toLowerCase()
  const found = nodes.find(
    (n): n is StickyNode =>
      n.kind === 'sticky' &&
      n.projectId === caller.projectId &&
      n.title.trim().toLowerCase() === title &&
      (!n.openedBy || n.openedBy === caller.id) &&
      n.text.trim() !== ''
  )
  return found ? { id: found.id, text: found.text } : null
}

export function withTeamRules(brief: string, rules: TeamRules): string {
  return `Team rules (from the "${TEAM_RULES_TITLE}" note on the canvas, for every member):\n${rules.text.trimEnd()}\n\nYour brief:\n${brief}`
}
