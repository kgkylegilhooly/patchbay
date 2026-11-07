import { reduce } from '../core/canvas/reduce'
import type { DocStore, LoadResult } from '../core/persist/docStore'
import type { CanvasStore } from '../shared/contract'
import type { CanvasDoc } from '../shared/model'

export interface AppStore extends CanvasStore {
  /** How the doc was loaded, so the app can say when it recovered from a bad file. */
  loaded: LoadResult
}

/** The one live canvas document. Throws if the save file can't be read, rather than starting empty. */
export function createAppStore(docStore: DocStore): AppStore {
  const loaded = docStore.load()
  let doc: CanvasDoc = loaded.doc
  const subscribers = new Set<(d: CanvasDoc) => void>()
  let notifying = false
  let changedAgain = false

  return {
    loaded,
    get: () => doc,
    subscribe(cb) {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
    dispatch(op) {
      const next = reduce(doc, op)
      if (next === doc) return
      doc = next
      docStore.saveDebounced(doc)
      // A subscriber can dispatch. Waiting for the round to end stops anyone seeing older after newer.
      if (notifying) {
        changedAgain = true
        return
      }
      notifying = true
      try {
        do {
          changedAgain = false
          const current = doc
          for (const cb of [...subscribers]) cb(current)
        } while (changedAgain)
      } finally {
        notifying = false
      }
    }
  }
}
