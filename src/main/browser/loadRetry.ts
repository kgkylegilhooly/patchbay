import { describeFailure, codeName, NOT_A_FAILURE, RETRY_EVERY_MS, RETRY_FOR_MS, type BrowserFailure } from '../../shared/browserFailure'

/**
 * Follows one page's loads and says when the latest one failed, trying a dev server's address again every couple of
 * seconds for a minute. Keyed by the page itself, not its node: the first load starts before the node has told main
 * which page is its own, and its failure was lost. See docs/plans/r3-content.md.
 *
 * A load is one start to one stop. It failed if the main frame's load failed on the way; any other stop is a page that
 * came in. That holds whichever of Chromium's finish events an error page does or doesn't send.
 */
export interface LoadRetry<K> {
  started(page: K): void
  failed(page: K, code: number, description: string, url: string): void
  stopped(page: K): void
  /** The person or an agent went somewhere, or asked for a reload: a fresh minute of trying. */
  reset(page: K): void
  /** The page's latest failure, if its latest load failed. */
  current(page: K): BrowserFailure | null
  forget(page: K): void
}

export function createLoadRetry<K>(deps: {
  reload(page: K): void
  show(page: K, failure: BrowserFailure | null): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}): LoadRetry<K> {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout))
  const pages = new Map<K, { failing: boolean; failure: BrowserFailure | null; streak: { url: string; since: number } | null; timer: unknown }>()
  const of = (page: K) => {
    let p = pages.get(page)
    if (!p) pages.set(page, (p = { failing: false, failure: null, streak: null, timer: null }))
    return p
  }
  const stopTimer = (p: { timer: unknown }): void => {
    if (p.timer !== null) clearTimer(p.timer)
    p.timer = null
  }
  return {
    started(page) {
      of(page).failing = false
    },
    failed(page, code, description, url) {
      if (NOT_A_FAILURE.has(code)) return
      const p = of(page)
      p.failing = true
      const at = now()
      if (!p.streak || p.streak.url !== url) p.streak = { url, since: at }
      const said = describeFailure(description, url)
      const inTime = at + RETRY_EVERY_MS - p.streak.since <= RETRY_FOR_MS
      const retryAt = said.retryable && inTime ? at + RETRY_EVERY_MS : null
      stopTimer(p)
      if (retryAt !== null) {
        p.timer = setTimer(() => {
          p.timer = null
          deps.reload(page)
        }, RETRY_EVERY_MS)
      }
      p.failure = { url, code: codeName(description), title: said.title, detail: said.detail, retryAt, gaveUp: said.retryable && !inTime }
      deps.show(page, p.failure)
    },
    stopped(page) {
      const p = of(page)
      if (p.failing) return
      stopTimer(p)
      p.streak = null
      if (p.failure) {
        p.failure = null
        deps.show(page, null)
      }
    },
    reset(page) {
      const p = pages.get(page)
      if (!p) return
      stopTimer(p)
      p.streak = null
    },
    current: (page) => pages.get(page)?.failure ?? null,
    forget(page) {
      const p = pages.get(page)
      if (p) stopTimer(p)
      pages.delete(page)
    }
  }
}
