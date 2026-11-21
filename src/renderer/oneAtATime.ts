/**
 * Runs refreshes one at a time. One asked for while another runs may need what changed since that one began, as after
 * a git pull, so it isn't dropped: the newest one asked for runs when the current one ends, and every caller waiting
 * meanwhile resolves when it has. Without this, the refresh after a pull could be skipped, leaving an older answer shown.
 */
export function oneAtATime(): (run: () => Promise<void>) => Promise<void> {
  let current: Promise<void> | null = null
  let next: { run: () => Promise<void>; done: Promise<void> } | null = null

  const start = (run: () => Promise<void>): Promise<void> => {
    const p = run()
      .catch(() => {})
      .finally(() => {
        if (current === p) current = null
      })
    current = p
    return p
  }

  return (run) => {
    if (!current) return start(run)
    if (next) {
      next.run = run
      return next.done
    }
    const queued: { run: () => Promise<void>; done: Promise<void> } = {
      run,
      done: current.then(() => {
        next = null
        return start(queued.run)
      })
    }
    next = queued
    return queued.done
  }
}
