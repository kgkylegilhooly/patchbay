import { FILE_NODE_SIZE, fileName, quotePathFor, type PathTarget } from '../shared/fileShelf'
import { shellKind } from '../shared/terminalProfiles'
import type { CanvasDoc, CanvasNode, FileNode } from '../shared/model'
import { placed, type Place } from './newNodes'

/**
 * File icons for these paths, one each, placed in turn so none lands on another: the first at the spot, the rest in
 * the nearest free spots around it, or inside the group in its next free cells.
 */
export function newFileNodes(p: Place, paths: string[], makeId: () => string): FileNode[] {
  let doc: CanvasDoc = p.doc
  const out: FileNode[] = []
  for (const path of paths) {
    const node: FileNode = { ...placed({ ...p, doc }, FILE_NODE_SIZE), id: makeId(), kind: 'file', title: fileName(path), path }
    if (!p.group) node.projectId = doc.activeProjectId
    else if (p.group.projectId) node.projectId = p.group.projectId
    out.push(node)
    doc = { ...doc, nodes: [...doc.nodes, node] }
  }
  return out
}

/** Who reads a path typed into this window: an agent's prompt, or a terminal's shell. Null for anything else. */
export function pathTargetOf(node: CanvasNode | undefined, profiles: { profiles: Array<{ id: string; program: string }>; defaultId: string } | null): PathTarget | null {
  if (!node) return null
  if (node.kind === 'claude') return 'agent'
  if (node.kind !== 'terminal') return null
  // An SSH terminal is a Linux shell on the far side, as near as can be told.
  if (node.sshHost) return 'bash'
  const list = profiles?.profiles ?? []
  const profile = list.find((p) => p.id === node.profile) ?? list.find((p) => p.id === profiles?.defaultId) ?? list[0]
  return profile ? shellKind(profile.program) : 'other'
}

/** What dropping or dragging files onto a window types into it: each path quoted for it, with a space after. */
export function typedPaths(paths: string[], target: PathTarget): string {
  return paths.map((p) => quotePathFor(p, target)).join('')
}
