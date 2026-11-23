/**
 * A repeating check that slows down while it finds nothing new. Ten agents sitting idle still had main running a
 * couple of hundred timed checks every 30 s, and reading the same folders 75 times, while nothing changed.
 *
 * Each run says whether it found anything. One that did keeps the check at `baseMs`; each that didn't doubles the wait,
 * up to `maxMs`. `wake` brings it back to `baseMs` at once, for news from elsewhere that things are moving again.
 * Uses setInterval, so the check still runs on its own if a run never settles.
 */
export interface Backoff {
  wake(): void
  close(): void
  /** The wait now, for tests. */
  everyMs(): number
}

export function backoffInterval(run: () => boolean | Promise<boolean>, baseMs: number, maxMs = baseMs * 8): Backoff {
  let period = baseMs
  let timer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const schedule = (next: number): void => {
    if (closed || (timer && next === period)) return
    period = next
    if (timer) clearInterval(timer)
    timer = setInterval(tick, period)
    timer.unref?.()
  }

  const settle = (found: boolean): void => schedule(found ? baseMs : Math.min(maxMs, period * 2))

  function tick(): void {
    let result: boolean | Promise<boolean>
    try {
      result = run()
    } catch {
      return settle(false)
    }
    if (typeof result === 'boolean') settle(result)
    else result.then(settle, () => settle(false))
  }

  timer = setInterval(tick, period)
  timer.unref?.()

  return {
    wake: () => schedule(baseMs),
    close() {
      closed = true
      if (timer) clearInterval(timer)
      timer = null
    },
    everyMs: () => period
  }
}
