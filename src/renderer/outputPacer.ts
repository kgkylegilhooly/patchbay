/**
 * How often a window that isn't being typed in draws its output. A busy agent prints many times a second, and every
 * print made its terminal draw again: with ten at once the window spent nearly all its time drawing on a modest PC.
 * Ten times a second still shows a spinner turning and text arriving, for a fraction of the work.
 */
export const BACKGROUND_PACE_MS = 100

export interface OutputPacer {
  write(data: string): void
  /** Writes whatever is held now, as when the window gets focus. */
  flush(): void
  dispose(): void
}

/**
 * Hands output on at once while `immediate` says so, as for the terminal being typed in, so echo is never held up.
 * Otherwise it's gathered and handed on together, at most every `everyMs`. Order is always kept.
 */
export function createOutputPacer(write: (data: string) => void, immediate: () => boolean, everyMs = BACKGROUND_PACE_MS): OutputPacer {
  let held: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (held.length === 0 || disposed) return
    const data = held.length === 1 ? held[0] : held.join('')
    held = []
    write(data)
  }

  return {
    write(data) {
      if (disposed) return
      if (immediate()) {
        flush()
        write(data)
        return
      }
      held.push(data)
      timer ??= setTimeout(flush, everyMs)
    },
    flush,
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      held = []
    }
  }
}
