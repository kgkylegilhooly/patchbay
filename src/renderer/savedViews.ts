import type { Viewport } from '../shared/model'

/**
 * Views kept in slots 1 to 9 for each project, to come back to a part of a big canvas in one key: Alt+Shift+N keeps
 * the view in slot N, Alt+N goes back to it. Kept in this window's storage, beside the other preferences, so the
 * canvas file is untouched.
 */

export const VIEW_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
const KEY = 'patchbay.savedViews'

type Saved = Record<string, Record<string, Viewport>>

export interface ViewStore {
  get(projectId: string, slot: number): Viewport | null
  set(projectId: string, slot: number, view: Viewport): void
}

const isView = (v: unknown): v is Viewport => {
  const o = v as Partial<Viewport> | null
  return !!o && [o.x, o.y, o.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)) && (o.zoom as number) > 0
}

/** Over any string storage; the app's is localStorage. Unreadable storage reads as no views saved. */
export function createViewStore(storage: Pick<Storage, 'getItem' | 'setItem'>): ViewStore {
  const read = (): Saved => {
    try {
      const parsed = JSON.parse(storage.getItem(KEY) ?? '{}') as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Saved) : {}
    } catch {
      return {}
    }
  }
  return {
    get(projectId, slot) {
      const view = read()[projectId]?.[String(slot)]
      return isView(view) ? { x: view.x, y: view.y, zoom: view.zoom } : null
    },
    set(projectId, slot, view) {
      const all = read()
      all[projectId] = { ...(all[projectId] ?? {}), [String(slot)]: { x: view.x, y: view.y, zoom: view.zoom } }
      try {
        storage.setItem(KEY, JSON.stringify(all))
      } catch {
        // Storage full or off: the view just isn't kept.
      }
    }
  }
}

let shared: ViewStore | null = null
/** The app's store, made when first used, since tests load this module where there's no window. */
export const savedViews = (): ViewStore => (shared ??= createViewStore(window.localStorage))
