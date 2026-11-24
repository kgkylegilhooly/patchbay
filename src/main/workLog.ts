/**
 * Work the main process starts, kept for a minute, so a stall in the log can say what was under way. The log had 1 to
 * 5 s stalls just after the PC woke, when every overdue timer fires at once, and nothing said which job held it.
 * A mark is a push onto an array: put one where periodic or wake-up work begins.
 */

const KEEP_MS = 60_000
const MAX_MARKS = 300
/** A stall line names at most this many kinds of work. */
const MAX_NAMED = 8

export interface WorkLog {
  note(label: string): void
  /** The kinds of work started from `from` to `to`, in the order first seen, with a count when more than once. */
  during(from: number, to: number): string[]
}

export function createWorkLog(now: () => number = () => Date.now()): WorkLog {
  const marks: Array<{ label: string; at: number }> = []
  return {
    note(label) {
      const at = now()
      marks.push({ label, at })
      while (marks.length > MAX_MARKS || (marks.length > 0 && at - marks[0].at > KEEP_MS)) marks.shift()
    },
    during(from, to) {
      const counts = new Map<string, number>()
      for (const m of marks) if (m.at >= from && m.at <= to) counts.set(m.label, (counts.get(m.label) ?? 0) + 1)
      return [...counts].slice(0, MAX_NAMED).map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
    }
  }
}

/** The one the app's jobs mark. */
export const workLog = createWorkLog()
export const noteWork = (label: string): void => workLog.note(label)

/** A stall, for the log, with the work that started around it when there was any. */
export function stallText(ms: number, work: string[]): string {
  const line = `The main process was blocked for ${(ms / 1000).toFixed(1)} s.`
  return work.length ? `${line} Started just before or during it: ${work.join(', ')}.` : line
}
