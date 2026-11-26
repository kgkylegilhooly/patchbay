import type { RunResult } from '../shared/contract'

/**
 * F50: Restart when it stops. A dev server that crashes stayed down until someone noticed. A run with the option on
 * is started again after a crash (a non-zero exit, not Stop), after 2 s, then 5 s, then 15 s. A fourth crash within a
 * minute gives up and says so. A clean exit, a Stop, and an end only seen at start-up restart nothing.
 */

const DELAYS_MS = [2000, 5000, 15000]
const WINDOW_MS = 60_000

export type KeeperAnswer = 'restarting' | 'gave-up' | 'none'

export function createRunKeeper(d: {
  /** The run's Restart when it stops is on. */
  keep: (id: string) => boolean
  running: (id: string) => boolean
  /** Starts it again as Restart does. */
  restart: (id: string) => Promise<unknown>
  gaveUp: (id: string) => void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => void
}) {
  const now = d.now ?? Date.now
  const schedule = d.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.())
  /** Seen running in this launch, so its end is one that happened now. */
  const seenRunning = new Set<string>()
  const crashes = new Map<string, number[]>()
  return {
    /** Each run result as the runner reports it. Says what it did, so a crash being restarted isn't also a failure notice. */
    onRun(id: string, run: RunResult): KeeperAnswer {
      if (run.running) {
        seenRunning.add(id)
        return 'none'
      }
      const live = seenRunning.delete(id)
      if (!live || run.stoppedByYou || !run.exitCode || !d.keep(id)) {
        if (run.stoppedByYou || run.exitCode === 0) crashes.delete(id)
        return 'none'
      }
      const at = now()
      const recent = [...(crashes.get(id) ?? []).filter((t) => at - t < WINDOW_MS), at]
      if (recent.length > DELAYS_MS.length) {
        crashes.delete(id)
        d.gaveUp(id)
        return 'gave-up'
      }
      crashes.set(id, recent)
      schedule(() => {
        // Started again by hand meanwhile, or the option was turned off: nothing to do.
        if (!d.keep(id) || d.running(id)) return
        void d.restart(id).catch(() => undefined)
      }, DELAYS_MS[recent.length - 1])
      return 'restarting'
    }
  }
}
