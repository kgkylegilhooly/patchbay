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
}

export function createTerminalShelf<T>(
  dispose: (value: T) => void,
  keepMs: () => number,
  timers: { set: (cb: () => void, ms: number) => unknown; clear: (t: unknown) => void } = { set: (cb, ms) => setTimeout(cb, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }
): TerminalShelf<T> {
  const kept = new Map<string, Shelved<T> & { timer: unknown }>()

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
      kept.set(id, { ...entry, timer })
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
    ids: () => [...kept.keys()]
  }
}
