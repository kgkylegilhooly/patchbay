import type { CanvasStore } from '../../shared/contract'
import { pathKey } from '../../shared/fileShelf'
import type { CanvasDoc } from '../../shared/model'
import type { FileShelfStore } from './store'

/**
 * Puts every document opened in a Reader on its project's shelf, as "Opened in the doc viewer", whoever opened it: the
 * person, an agent's `open-doc`, or a terminal's path menu. It watches the canvas for new reader nodes, so the reader
 * itself needn't know about the shelf. Readers already open at startup are added only if the shelf doesn't have them.
 */
export function noteReaders(store: CanvasStore, shelf: FileShelfStore, now: () => number = Date.now): () => void {
  const seen = new Set<string>()
  const scan = (doc: CanvasDoc, atStart: boolean): void => {
    for (const n of doc.nodes) {
      if (n.kind !== 'reader' || seen.has(n.id)) continue
      seen.add(n.id)
      const projectId = n.projectId ?? doc.activeProjectId
      if (atStart && shelf.list(projectId).some((e) => pathKey(e.path) === pathKey(n.path))) continue
      const from = n.fromNodeId ? doc.nodes.find((f) => f.id === n.fromNodeId) : undefined
      shelf.note(projectId, { path: n.path, source: 'doc', at: now(), ...(from ? { nodeTitle: from.title } : {}) })
    }
  }
  scan(store.get(), true)
  return store.subscribe((doc) => scan(doc, false))
}
