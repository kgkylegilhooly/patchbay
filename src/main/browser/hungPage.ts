/**
 * A browser node's page that stops answering, such as one stuck in a loop. Its page runs in a renderer process apart
 * from the canvas, so the canvas carries on; this tells the node, and makes Reload work on it. A reload sent to a stuck
 * page is lost with it, so its process is ended first and the reload follows once it's gone.
 *
 * Electron says a page is unresponsive only once input has waited on it for a long while, so every page is also asked
 * for a trivial answer every few seconds, and whenever Reload is pressed.
 *
 * Pages of the same site can share one renderer process (Chromium does so past its process limit, which it sizes from
 * memory, so more on a PC short of it). Those pages share its thread, so when one is stuck they all are, and ending
 * the process ends them all: they're restarted together (restartTogether).
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
  /** True while its process is being ended on purpose, which isn't the page failing. */
  readonly restarting: boolean
  /** For Reload: true when the page is known to be stuck, or doesn't answer within reloadAnswerMs. */
  stuck(): Promise<boolean>
  /** Its process is about to be ended on purpose: once it's gone the page reloads, and if it never goes, after restartWaitMs anyway. */
  expectRestart(): void
  stop(): void
}

export interface HungTiming {
  /** The heartbeat: a page that hasn't answered in this long is stuck. */
  answerMs: number
  /** Reload's check waits longer, so a page that's only busy isn't ended. */
  reloadAnswerMs: number
  /** How often each page is asked. 0 asks only when Reload is pressed. */
  everyMs: number
  /** How long a restart waits for the process to end before reloading anyway. */
  restartWaitMs: number
}
export const HUNG_TIMING: HungTiming = { answerMs: 1500, reloadAnswerMs: 4000, everyMs: 5000, restartWaitMs: 5000 }

export function watchHungPage(guest: HungGuest, d: { onHung(): void; onRecovered(): void }, timing: Partial<HungTiming> = {}): HungPage {
  const t = { ...HUNG_TIMING, ...timing }
  let hung = false
  let restarting = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null
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
  const answers = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      guest.executeJavaScript('1').then(
        () => (clearTimeout(timer), resolve(true)),
        () => (clearTimeout(timer), resolve(true))
      )
    })

  const check = async (): Promise<void> => {
    if (asking || restarting || guest.isDestroyed() || guest.isLoading()) return
    asking = true
    try {
      const ok = await answers(t.answerMs)
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
    if (restartTimer) clearTimeout(restartTimer)
  }

  const reloadNow = (): void => {
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = null
    restarting = false
    if (!guest.isDestroyed()) guest.reload()
  }

  guest.on('unresponsive', nowHung)
  guest.on('responsive', nowFine)
  guest.on('destroyed', stop)
  guest.on('render-process-gone', () => {
    hung = false
    // Listeners run in the order they were added, so the driver's own handler has seen `restarting` already.
    if (restarting) queueMicrotask(reloadNow)
  })

  return {
    get hung() {
      return hung
    },
    get restarting() {
      return restarting
    },
    async stuck() {
      if (guest.isDestroyed() || restarting) return false
      return hung || !(await answers(t.reloadAnswerMs))
    },
    expectRestart() {
      if (restarting || guest.isDestroyed()) return
      restarting = true
      nowFine()
      restartTimer = setTimeout(reloadNow, t.restartWaitMs)
      restartTimer.unref?.()
    },
    stop
  }
}

/**
 * Starts a stuck page again by ending its process, and every page that shares that process with it: they're stuck
 * with it, and would end with it anyway, so each reloads rather than reporting a crash.
 */
export function restartTogether(page: HungPage, guest: Pick<HungGuest, 'forcefullyCrashRenderer'>, sharing: HungPage[]): void {
  for (const other of sharing) other.expectRestart()
  page.expectRestart()
  guest.forcefullyCrashRenderer()
}
