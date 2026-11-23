import type { CanvasDoc } from '../shared/model'

/**
 * The nodes of the project on screen. A node with no project shows on the one on screen, as loading rehomes it there.
 * Everything else a window watches is out of sight, as another project's terminals kept warm after a switch are.
 */
export function onScreenIds(doc: CanvasDoc): Set<string> {
  return new Set(doc.nodes.filter((n) => (n.projectId ?? doc.activeProjectId) === doc.activeProjectId).map((n) => n.id))
}
