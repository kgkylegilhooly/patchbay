import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { NO_PROBLEMS, SAVE_RETRY_MS, saveReason, shortError, type AppProblems } from '../shared/appProblems'

/**
 * The app's own problems, as banners in the window rather than native dialogs (see shared/appProblems.ts).
 *
 * A failed save used to wait for the next change to be tried again. Now it's also tried every few seconds, so the
 * banner clears by itself once the disk has room or the folder is writable again, and says so.
 */
export interface AppProblemsState {
  get(): AppProblems
  saveFailed(e: unknown, dir: string): void
  saved(): void
  hostLost(): void
  /** Runs `bring` once, however often it's asked for while it runs. Clears the banner when it's done. */
  bringBackHost(bring: () => Promise<void>): Promise<void>
  dismissHostLost(): void
}

export function createAppProblems(deps: {
  /** Tries the save again. Rejects if it fails again. */
  retrySave(): Promise<void>
  push(problems: AppProblems): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}): AppProblemsState {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref())
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout))
  let problems: AppProblems = NO_PROBLEMS
  let retry: unknown = null
  const set = (next: Partial<AppProblems>): void => {
    problems = { ...problems, ...next }
    deps.push(problems)
  }
  const scheduleRetry = (): void => {
    if (retry !== null) return
    retry = setTimer(() => {
      retry = null
      if (!problems.save) return
      deps.retrySave().then(
        () => state.saved(),
        (e) => state.saveFailed(e, problems.save?.dir ?? '')
      )
    }, SAVE_RETRY_MS)
  }
  const state: AppProblemsState = {
    get: () => problems,
    saveFailed(e, dir) {
      const error = saveReason(e)
      const was = problems.save
      if (!was || was.error !== error || was.dir !== dir) set({ save: { dir, error, since: was?.since ?? now() } })
      scheduleRetry()
    },
    saved() {
      if (retry !== null) clearTimer(retry)
      retry = null
      if (problems.save) set({ save: null })
    },
    hostLost() {
      set({ hostLost: { at: now(), bringing: false, error: null } })
    },
    async bringBackHost(bring) {
      const lost = problems.hostLost
      if (lost?.bringing) return
      set({ hostLost: lost ? { ...lost, bringing: true, error: null } : null })
      try {
        await bring()
        set({ hostLost: null })
      } catch (e) {
        set({ hostLost: { at: lost?.at ?? now(), bringing: false, error: shortError(e) } })
      }
    },
    dismissHostLost() {
      if (problems.hostLost) set({ hostLost: null })
    }
  }
  return state
}

/** Serves `pb:problems:*`; see src/preload/appProblems.ts. Only the app's own page may ask. */
export function serveAppProblems(state: AppProblemsState, deps: { replaceHost(): Promise<void>; isAppUi(e: IpcMainInvokeEvent): boolean }): void {
  ipcMain.handle('pb:problems:get', () => state.get())
  ipcMain.handle('pb:problems:bringBackHost', (e) => (deps.isAppUi(e) ? state.bringBackHost(deps.replaceHost) : undefined))
  ipcMain.handle('pb:problems:dismissHostLost', (e) => {
    if (deps.isAppUi(e)) state.dismissHostLost()
  })
}
