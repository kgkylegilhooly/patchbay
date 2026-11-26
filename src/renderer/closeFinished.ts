import type { FilesBridge } from '../shared/filesTouched'
import type { AgentStatus, CanvasNode } from '../shared/model'

/**
 * F60, Close N finished agents: after a team run, a group's idle agents close in one step. An agent that left edits of
 * its own uncommitted (F20's check) stays open and is named. Closed conversations can reopen any that closed.
 */

/** A slower check closes nothing: unlike one window's Close, this closes many, so it never goes ahead blind. */
const CHECK_MS = 2000

/** The nodes inside a group, at any depth, the group itself left out. */
function insideGroup(nodes: CanvasNode[], groupId: string): CanvasNode[] {
  const inside = new Set([groupId])
  for (let grew = true; grew; ) {
    grew = false
    for (const n of nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) grew = !!inside.add(n.id)
  }
  return nodes.filter((n) => n.id !== groupId && inside.has(n.id))
}

/** The agents inside a group that are idle: not working, not waiting on the person. */
export function finishedIn(nodes: CanvasNode[], groupId: string, statuses: Partial<Record<string, AgentStatus>>): CanvasNode[] {
  return insideGroup(nodes, groupId).filter((n) => n.kind === 'claude' && statuses[n.id] === 'idle')
}

const names = (titles: string[]): string => (titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0])

type Found = { id: string; title: string; files: string[] }

/** Which to close, and what the confirmation says: what closes, and which stay open and why. */
export function finishedPlan(found: Found[]): { close: Found[]; message: string } {
  const close = found.filter((f) => f.files.length === 0)
  const kept = found.filter((f) => f.files.length > 0)
  const parts = close.length ? [`Closes ${names(close.map((f) => f.title))}. Closed conversations can reopen each.`] : []
  for (const k of kept) parts.push(`${k.title} stays open: it left ${k.files.length} file${k.files.length === 1 ? '' : 's'} it edited uncommitted.`)
  return { close, message: parts.join(' ') }
}

export async function closeFinishedAgents(
  agents: Array<{ id: string; title: string }>,
  files: Pick<FilesBridge, 'uncommitted'> | undefined,
  close: (ids: string[]) => void,
  ask: (message: string, run: () => void) => Promise<void> | void,
  say: (text: string) => void = () => {},
  checkMs = CHECK_MS
): Promise<void> {
  if (!agents.length) return
  const unchecked = "Couldn't check what these agents left uncommitted, so none was closed."
  if (!files) return say(unchecked)
  const look = Promise.all(agents.map(async (a) => ({ ...a, files: await files.uncommitted(a.id) })))
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), checkMs))
  const found = await Promise.race([look, timeout]).catch(() => null)
  if (!found) return say(unchecked)
  const plan = finishedPlan(found)
  if (!plan.close.length) return say(plan.message)
  await ask(plan.message, () => close(plan.close.map((f) => f.id)))
}
