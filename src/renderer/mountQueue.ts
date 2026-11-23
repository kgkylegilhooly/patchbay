/**
 * Builds new terminals a few at a time rather than all in one frame. Each one measures its font, adds its styles and
 * replays its session, and twenty-odd at once (opening a busy project) froze the window for a third of a second.
 * Those on screen go first; each frame builds as many as fit in `budgetMs`, and at least one. Pure apart from the
 * scheduler it's given, so it can be tested.
 */
export interface MountQueue {
  /**
   * Asks to build. `onScreen` ones go ahead of the rest. `key` names it for `prioritize`. Returns a cancel, for a
   * window gone before its turn.
   */
  request(onScreen: boolean, run: () => void, key?: string): () => void
  /** Moves a waiting build to the very front, as for a window about to be given the keyboard. */
  prioritize(key: string): void
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
    request(onScreen, run, key) {
      let done = false
      const job = Object.assign(
        (): void => {
          done = true
          run()
        },
        { key }
      )
      ;(onScreen ? first : rest).push(job)
      kick()
      return () => {
        if (done) return
        for (const list of [first, rest]) {
          const i = list.indexOf(job)
          if (i >= 0) list.splice(i, 1)
        }
      }
    },
    prioritize(key) {
      for (const list of [first, rest]) {
        const i = list.findIndex((j) => (j as { key?: string }).key === key)
        if (i < 0) continue
        const [job] = list.splice(i, 1)
        first.unshift(job)
        return
      }
    },
    pending: () => first.length + rest.length
  }
}

/**
 * Once the next frame has been drawn: a task queued from that frame's animation callbacks runs after its paint. Or a
 * moment from now if no frame comes. Returns a cancel. Used for work that would only make the frame of a project switch
 * longer, such as kept terminals drawing what they gathered while away.
 */
export function afterNextPaint(cb: () => void, frame: (f: () => void) => unknown = requestAnimationFrame, later: (f: () => void, ms: number) => unknown = setTimeout): () => void {
  let state: 'waiting' | 'done' | 'cancelled' = 'waiting'
  const run = (): void => {
    if (state !== 'waiting') return
    state = 'done'
    cb()
  }
  frame(() => later(run, 0))
  later(run, 100)
  return () => {
    if (state === 'waiting') state = 'cancelled'
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
