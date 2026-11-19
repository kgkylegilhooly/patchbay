import type { ShelfSource } from '../shared/fileShelf'
import { bridge } from './bridge'
import { newFileNodes, pathTargetOf, typedPaths } from './fileNodes'
import { checkFiles, filesBridge } from './fileShelfUi'
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

/** Types these paths into a terminal or agent window, quoted for it. False when the window takes no typing. */
export function typePathsInto(nodeId: string, paths: string[]): boolean {
  const node = useStore.getState().doc?.nodes.find((n) => n.id === nodeId)
  const target = pathTargetOf(node, currentTerminalProfiles())
  if (!target || !paths.length) return false
  bridge.input(nodeId, typedPaths(paths, target))
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
