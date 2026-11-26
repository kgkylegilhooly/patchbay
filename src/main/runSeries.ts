import type { RunResult } from '../shared/contract'
import type { SeriesState } from '../shared/runSeries'
export type { SeriesState } from '../shared/runSeries'
export { seriesText } from '../shared/runSeries'

/**
 * F64, Run N times: a flaky test needed runs by hand, counting failures. A series starts the run, and after each end
 * starts it again until it has run N times, counting the ones that failed. Stop ends it; so does closing the window.
 * While it lasts it owns the run's ends: no failure notice per run and no Restart when it stops, just one summary.
 */

const MIN = 2
const MAX = 50
/** A breath between runs, so the last one's output settles and a port it held is let go. */
const GAP_MS = 500

type Refusal = { ok: false; reason: string }

export function createRunSeries(d: {
  /** Starts the run as Restart does. A launch.json run whose command changed is refused (LJ1). */
  restart: (id: string) => Promise<unknown>
  running: (id: string) => boolean
  changed: (id: string, state: SeriesState | null) => void
  finished: (id: string, text: string) => void
  schedule?: (fn: () => void, ms: number) => void
}) {
  const schedule = d.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.())
  const series = new Map<string, SeriesState>()
  const seen = new Set<string>()

  const end = (id: string, state: SeriesState, text: string): void => {
    const last = { ...state, running: false }
    series.delete(id)
    seen.delete(id)
    d.changed(id, last)
    d.finished(id, text)
  }

  const refused = (r: unknown): Refusal | null =>
    r && typeof r === 'object' && (r as { ok?: unknown }).ok === false ? { ok: false, reason: String((r as { reason?: unknown }).reason ?? 'It could not start.') } : null

  const next = async (id: string): Promise<Refusal | null> => {
    const r = refused(await d.restart(id).catch((e: unknown) => ({ ok: false, reason: (e as Error).message })))
    const state = series.get(id)
    if (r && state) end(id, state, `Stopped after ${state.done} of ${state.total} runs: ${r.reason}`)
    return r
  }

  return {
    async start(id: string, total: number): Promise<{ ok: true } | Refusal> {
      if (!Number.isInteger(total) || total < MIN || total > MAX) return { ok: false, reason: `Run it ${MIN} to ${MAX} times.` }
      if (series.has(id) || d.running(id)) return { ok: false, reason: "It's running. Stop it first, or wait for it to end." }
      series.set(id, { total, done: 0, failed: 0, running: true })
      d.changed(id, series.get(id)!)
      const r = refused(await d.restart(id).catch((e: unknown) => ({ ok: false, reason: (e as Error).message })))
      if (r) {
        series.delete(id)
        d.changed(id, null)
        return r
      }
      return { ok: true }
    },

    /** Each run result. True when the series took it, so it's not a failure notice or a keeper's restart too. */
    onRun(id: string, run: RunResult): boolean {
      const state = series.get(id)
      if (!state) return false
      if (run.running) {
        seen.add(id)
        return true
      }
      // An end without a start seen in this series (one already under way, say) isn't one of its runs.
      if (!seen.delete(id)) return true
      if (run.stoppedByYou) {
        end(id, state, `Stopped after ${state.done} of ${state.total} runs: ${state.failed} failed.`)
        return true
      }
      const now = { ...state, done: state.done + 1, failed: state.failed + (run.exitCode === 0 ? 0 : 1) }
      if (now.done >= now.total) {
        end(id, now, now.failed ? `${now.failed} of ${now.total} runs failed.` : `All ${now.total} runs passed.`)
        return true
      }
      series.set(id, now)
      d.changed(id, now)
      schedule(() => {
        if (series.get(id) !== now || d.running(id)) return
        void next(id)
      }, GAP_MS)
      return true
    },

    state(id: string): SeriesState | null {
      return series.get(id) ?? null
    },

    /** The window closed: its series ends, saying nothing. */
    forget(id: string): void {
      series.delete(id)
      seen.delete(id)
    }
  }
}
