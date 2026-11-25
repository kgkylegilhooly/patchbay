import { agentOf, type CanvasNode } from '../shared/model'
import { newClaude, newSsh, newTerminal, type Place } from './newNodes'

/**
 * Duplicate, from a window's menu: a second shell in the same folder with the same profile, the same SSH host, or a new
 * agent of the same kind in the same folder with nothing to do yet. Never its output, its conversation or its command:
 * a duplicate starts fresh. Null for anything else.
 */
export function duplicateOf(src: CanvasNode, at: Place, id: string, profileOf: (id: string | undefined) => { id: string; name: string } | undefined): CanvasNode | null {
  if (src.kind === 'terminal') {
    if (src.sshHost) return newSsh(at, id, { host: src.sshHost, home: src.cwd })
    return newTerminal(at, id, { cwd: src.cwd, profile: profileOf(src.profile) })
  }
  if (src.kind === 'claude') return newClaude(at, id, { cwd: src.cwd, agent: agentOf(src) })
  return null
}
