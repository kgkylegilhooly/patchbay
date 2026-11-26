/** A run's series of runs (F64): how many it's to run, how many have ended, how many of those failed. */
export interface SeriesState {
  total: number
  done: number
  failed: number
  /** False once it's over: all run, or stopped. */
  running: boolean
}

/** The run window's chip: progress while it runs, the count after. */
export function seriesText(s: SeriesState): string {
  if (s.running) return `Run ${s.done + 1} of ${s.total}${s.failed ? ` · ${s.failed} failed` : ''}`
  if (s.done < s.total) return `Stopped at ${s.done} of ${s.total}${s.failed ? ` · ${s.failed} failed` : ''}`
  return s.failed ? `${s.failed} of ${s.total} failed` : `${s.total} of ${s.total} passed`
}
