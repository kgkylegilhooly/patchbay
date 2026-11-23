/**
 * Builds new terminals a few at a time rather than all in one frame. Each one measures its font, adds its styles and
 * replays its session, and twenty-odd at once (opening a busy project) froze the window for a third of a second.
 * Those on screen go first; each frame builds as many as fit in `budgetMs`, and at least one. Pure apart from the
 * scheduler it's given, so it can be tested.
 */
export interface MountQueue {
  /** Asks to build. `onScreen` ones go ahead of the rest. Returns a cancel, for a window gone before its turn. */
  request(onScreen: boolean, run: () => void): () => void
  pending(): number
}

export function createMountQueue(schedule: (cb: () => void) => void, now: () => number, budgetMs = 8): MountQueue {
  const first: Array<() => void> = []
  const rest: Array<() => void> = []
  let scheduled = false

  const pump = (): void => {
    scheduled = false
    const start = now()
    let ran = 0
    while (first.length + rest.length > 0 && (ran === 0 || now() - start < budgetMs)) {
      const run = (first.length ? first : rest).shift()!
      ran++
      run()
    }
    if (first.length + rest.length > 0) kick()
  }
  const kick = (): void => {
    if (scheduled) return
    scheduled = true
    schedule(pump)
  }

  return {
    request(onScreen, run) {
      const list = onScreen ? first : rest
      let done = false
      const job = (): void => {
        done = true
        run()
      }
      list.push(job)
      kick()
      return () => {
        if (done) return
        const i = list.indexOf(job)
        if (i >= 0) list.splice(i, 1)
      }
    },
    pending: () => first.length + rest.length
  }
}

/** The next frame, or a moment from now if no frame comes, as when the window is minimized. */
export function nextFrame(cb: () => void): void {
  let fired = false
  const once = (): void => {
    if (fired) return
    fired = true
    cb()
  }
  requestAnimationFrame(once)
  setTimeout(once, 100)
}
