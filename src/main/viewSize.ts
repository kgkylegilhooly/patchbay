import type { Size } from '../core/canvas/place'

/**
 * The size of the canvas window, so nodes added from the main process can land where the person is looking. The app
 * reports how to read it once its window exists. Without a window, as in tests, it's unknown and placement does
 * without it.
 */
let read: (() => Size | null) | null = null

export function reportViewSize(fn: () => Size | null): void {
  read = fn
}

export function viewSize(): Size | null {
  try {
    return read?.() ?? null
  } catch {
    return null
  }
}
