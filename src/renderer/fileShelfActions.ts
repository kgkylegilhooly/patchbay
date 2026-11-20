import type { ShelfSource } from '../shared/fileShelf'
import { bridge } from './bridge'
import { copyText } from './clipboard'
import { newFileNodes, pathTargetOf, typingFor } from './fileNodes'
import { checkFiles, fileNotice, filesBridge } from './fileShelfUi'
import type { Place } from './newNodes'
import { undoable, useStore } from './store'
import { currentTerminalProfiles } from './terminalProfilesUi'

/** File actions that change the canvas or type into a window. */

export function noteShared(projectId: string | undefined, paths: string[], source: ShelfSource, nodeTitle?: string): void {
  const id = projectId ?? useStore.getState().doc?.activeProjectId
  if (!id || !paths.length) return
  const at = Date.now()
  // A moment apart, so a drop of several keeps its order, newest first.
  void filesBridge()?.note(id, paths.map((path, i) => ({ path, source, at: at + i, ...(nodeTitle ? { nodeTitle } : {}) })))
}

/**
 * Types these paths into a terminal or agent window, quoted for it. A path its shell might act on is copied instead,
 * and nothing is typed into an agent waiting on the person, where keys could answer its question. False when the
 * window takes no typing at all.
 */
export function typePathsInto(nodeId: string, paths: string[]): boolean {
  const state = useStore.getState()
  const node = state.doc?.nodes.find((n) => n.id === nodeId)
  const target = pathTargetOf(node, currentTerminalProfiles())
  if (!node || !target || !paths.length) return false
  const decision = typingFor(paths, target, state.statuses[nodeId] ?? null, node.title)
  if (decision.type === 'type') bridge.input(nodeId, decision.text)
  else if (decision.type === 'copy') void copyText(paths.join('\n')).then(() => fileNotice(decision.reason), () => fileNotice("That path wasn't typed, since its shell might act on it, and it couldn't be copied either."))
  else fileNotice(decision.reason)
  return true
}

/** Where new file icons go, given by the canvas, which knows the view. Without it they go wherever place.ts puts them. */
export type Placer = (where: { at?: { x: number; y: number }; groupId?: string; besideId?: string }) => Place | null
let placer: Placer | null = null
export function setPlacer(p: Placer | null): void {
  placer = p
}

/**
 * Puts an icon for each path on the canvas, as one undoable step, and notes them on the shelf. `at` is a point on the
 * screen; without one they go beside `besideId`, or in the middle of the view.
 */
export function pinFiles(paths: string[], where: { at?: { x: number; y: number }; groupId?: string; besideId?: string }, source: ShelfSource, from?: string): string[] {
  const doc = useStore.getState().doc
  if (!doc || !paths.length) return []
  const place = placer?.(where) ?? { group: null, doc }
  const nodes = newFileNodes(place, paths, () => crypto.randomUUID())
  undoable(nodes.length > 1 ? 'add files' : 'add file', nodes.map((node) => ({ op: 'addNode' as const, node })))
  noteShared(nodes[0]?.projectId, paths, source, from)
  checkFiles(paths.map((path) => ({ path, network: true })))
  return nodes.map((n) => n.id)
}
