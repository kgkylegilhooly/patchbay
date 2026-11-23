/**
 * Terminals kept alive while their window isn't on the canvas, so coming back draws them at once instead of building
 * each again and replaying its whole session. Switching project tabs unmounted every terminal and, on the way back,
 * built and replayed them all in one go: a third of a second's freeze on a busy project. A window moved into a Focus
 * view pane, or maximized, is drawn somewhere else too, and comes back the same way.
 *
 * Only the project you just left is kept: leaving a third drops the first's, which is drawn afresh next time, as
 * every project was before. A kept terminal goes after `keepMs`, as a window far off-screen is unloaded after a while
 * (terminalParking.ts), and all go at once when memory is short. Pure apart from the timer, so it can be tested.
 */
export interface Shelved<T> {
  value: T
  /** Which drawing of the session this is (its epoch and refresh): a newer one is never served an old terminal. */
  key: string
  projectId: string | null
}

export interface TerminalShelf<T> {
  /** Keeps a terminal whose window went away. `activeProjectId` is the project on show now. */
  keep(id: string, entry: Shelved<T>, activeProjectId: string | null): void
  /** The kept terminal for this drawing of the window, taken off the shelf. One for another drawing is let go. */
  take(id: string, key: string): T | null
  /** Lets go of one, as when its window is closed. */
  drop(id: string): void
  clear(): void
  ids(): string[]
  /** About how many bytes the kept terminals hold, as weighed when kept. */
  bytes(): number
}

/**
 * How much the shelf may hold. A terminal's history is about 12 bytes a character cell (terminalParking.ts), so 27
 * terminals with full 10,000-line scrollbacks would hold some 390 MB. Past either limit the terminal kept longest ago
 * goes first, and is drawn afresh from its session when it's next shown, as every terminal was before.
 *
 * The limits are checked a moment after a terminal is kept (SETTLE_MS), not as each is kept. A project switch keeps the
 * windows of the project left before it takes back those of the project shown, so for that moment the shelf holds
 * both; and the windows of the project shown that are off screen are taken back a frame later (stagedFlow.ts).
 * Checked at once, a canvas of 33 terminals across two projects let go of one about to be taken back, at every
 * switch, and built it afresh in the switch's first frame.
 */
export const SETTLE_MS = 500

export interface ShelfBudget<T> {
  maxCount: number
  maxBytes: number
  /** About how many bytes a kept terminal holds. */
  weigh: (value: T) => number
  /**
   * Runs the check once things have settled. By default SETTLE_MS from now; the app also waits for two frames after
   * that, so a frame slower than SETTLE_MS (a busy PC) can't check before a switch's staged second frame takes back its terminals.
   */
  settle?: (check: () => void) => void
}

export function createTerminalShelf<T>(
  dispose: (value: T) => void,
  keepMs: () => number,
  timers: { set: (cb: () => void, ms: number) => unknown; clear: (t: unknown) => void } = { set: (cb, ms) => setTimeout(cb, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) },
  budget?: ShelfBudget<T>
): TerminalShelf<T> {
  // In the order kept, oldest first.
  const kept = new Map<string, Shelved<T> & { timer: unknown; bytes: number }>()
  let checkDue = false

  const drop = (id: string): void => {
    const e = kept.get(id)
    if (!e) return
    kept.delete(id)
    timers.clear(e.timer)
    dispose(e.value)
  }

  return {
    keep(id, entry, activeProjectId) {
      drop(id)
      // Leaving a project: only it and the one on show are kept, anything older goes. A window moving within the project
      // on show (maximized, into a pane) leaves the rest as they are.
      if (entry.projectId !== activeProjectId) {
        for (const [other, e] of [...kept]) if (e.projectId !== entry.projectId && e.projectId !== activeProjectId) drop(other)
      }
      const timer = timers.set(() => drop(id), keepMs())
      kept.set(id, { ...entry, timer, bytes: budget ? budget.weigh(entry.value) : 0 })
      if (!budget || checkDue) return
      checkDue = true
      const settle = budget.settle ?? ((check: () => void) => void timers.set(check, SETTLE_MS))
      settle(() => {
        checkDue = false
        let bytes = 0
        for (const e of kept.values()) bytes += e.bytes
        for (const [oldest, e] of [...kept]) {
          if (kept.size <= budget.maxCount && bytes <= budget.maxBytes) break
          bytes -= e.bytes
          drop(oldest)
        }
      })
    },
    take(id, key) {
      const e = kept.get(id)
      if (!e) return null
      if (e.key !== key) {
        drop(id)
        return null
      }
      kept.delete(id)
      timers.clear(e.timer)
      return e.value
    },
    drop,
    clear() {
      for (const id of [...kept.keys()]) drop(id)
    },
    ids: () => [...kept.keys()],
    bytes: () => [...kept.values()].reduce((n, e) => n + e.bytes, 0)
  }
}
