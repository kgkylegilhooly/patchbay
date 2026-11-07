/**
 * When each session last did something, for the sidebar. Held in memory only: after a restart a session shows no time
 * until it next does something, rather than a time that isn't true.
 */
export interface ActivityLog {
  /** `urgent` tells the window right away, as for a status change. Otherwise it's told at most every so often. */
  note(id: string, urgent: boolean): void
  forget(id: string): void
  all(): Record<string, number>
}

/** Output can be nonstop, and the sidebar only shows minutes, so this is about how out of date a time may be. */
const PUSH_EVERY_MS = 5000

export function createActivityLog({ push, now = Date.now }: { push: (id: string, at: number) => void; now?: () => number }): ActivityLog {
  const times = new Map<string, number>()
  const pushed = new Map<string, number>()
  return {
    note(id, urgent) {
      const at = now()
      times.set(id, at)
      const last = pushed.get(id)
      if (!urgent && last !== undefined && at - last < PUSH_EVERY_MS) return
      pushed.set(id, at)
      push(id, at)
    },
    forget(id) {
      times.delete(id)
      pushed.delete(id)
    },
    all: () => Object.fromEntries(times)
  }
}
