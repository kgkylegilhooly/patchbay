/**
 * A browser node's page that stops answering, such as one stuck in a loop. Its page runs in a process of its own, so
 * the canvas carries on; this tells the node, and makes Reload work on it. A reload sent to a stuck page is lost with
 * it, so its process is ended first and the reload follows once it's gone.
 *
 * Electron says a page is unresponsive only once input has waited on it for a long while, so the page is also asked
 * for a trivial answer now and then, and whenever Reload is pressed.
 */
export interface HungGuest {
  on(event: 'unresponsive' | 'responsive' | 'destroyed', cb: () => void): unknown
  on(event: 'render-process-gone', cb: (...args: unknown[]) => void): unknown
  forcefullyCrashRenderer(): void
  reload(): void
  isDestroyed(): boolean
  isLoading(): boolean
  /** Resolves once the page has run it. A stuck page never does. */
  executeJavaScript(code: string): Promise<unknown>
}

export interface HungPage {
  readonly hung: boolean
  /** True for the moment its process is gone because restart ended it, which isn't the page failing. */
  readonly restarting: boolean
  /** For Reload: starts a stuck page again and resolves true; resolves false for a page that answers, to reload as usual. */
  restart(): Promise<boolean>
  stop(): void
}

export interface HungTiming {
  /** A page that hasn't answered in this long is stuck. */
  answerMs: number
  /** How often a page is asked, while it's shown. 0 asks only when Reload is pressed. */
  everyMs: number
}
export const HUNG_TIMING: HungTiming = { answerMs: 1500, everyMs: 5000 }

export function watchHungPage(guest: HungGuest, d: { onHung(): void; onRecovered(): void }, timing: Partial<HungTiming> = {}): HungPage {
  const t = { ...HUNG_TIMING, ...timing }
  let hung = false
  let restarting = false
  let asking = false

  const nowHung = (): void => {
    if (hung) return
    hung = true
    d.onHung()
  }
  const nowFine = (): void => {
    if (!hung) return
    hung = false
    d.onRecovered()
  }

  /** True when the page answered in time. A refusal, as when it's between pages, is an answer too. */
  const answers = (): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), t.answerMs)
      guest.executeJavaScript('1').then(
        () => (clearTimeout(timer), resolve(true)),
        () => (clearTimeout(timer), resolve(true))
      )
    })

  const check = async (): Promise<void> => {
    if (asking || restarting || guest.isDestroyed() || guest.isLoading()) return
    asking = true
    try {
      const ok = await answers()
      if (guest.isDestroyed() || restarting) return
      if (ok) nowFine()
      else nowHung()
    } finally {
      asking = false
    }
  }

  const timer = t.everyMs > 0 ? setInterval(() => void check(), t.everyMs) : null
  timer?.unref?.()
  const stop = (): void => {
    if (timer) clearInterval(timer)
  }

  guest.on('unresponsive', nowHung)
  guest.on('responsive', nowFine)
  guest.on('destroyed', stop)
  guest.on('render-process-gone', () => {
    hung = false
    if (!restarting) return
    // Listeners run in the order they were added, so the driver's own handler has seen `restarting` already.
    queueMicrotask(() => {
      restarting = false
      if (!guest.isDestroyed()) guest.reload()
    })
  })

  return {
    get hung() {
      return hung
    },
    get restarting() {
      return restarting
    },
    async restart() {
      if (guest.isDestroyed() || restarting) return restarting
      if (!hung && (await answers())) return false
      if (guest.isDestroyed()) return false
      const wasHung = hung
      hung = false
      restarting = true
      if (wasHung) d.onRecovered()
      guest.forcefullyCrashRenderer()
      return true
    },
    stop
  }
}
