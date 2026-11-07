import type { AgentStatus } from '../shared/model'

/** Statuses during which an agent is busy and a sleeping PC would stall it. */
const BUSY = new Set<AgentStatus>(['working', 'starting'])

export interface KeepAwake {
  /** Call with every session's status after any change. */
  update(statuses: Record<string, AgentStatus>): void
  active(): boolean
  dispose(): void
}

/**
 * Keeps the PC from sleeping while an agent works. The screen may still turn off.
 * `start` and `stop` are Electron's powerSaveBlocker, passed in so this can be tested.
 */
export function createKeepAwake(deps: { start: () => number; stop: (id: number) => void; enabled: () => boolean }): KeepAwake {
  let held: number | null = null
  const release = (): void => {
    if (held === null) return
    deps.stop(held)
    held = null
  }
  return {
    update(statuses) {
      const busy = deps.enabled() && Object.values(statuses).some((s) => BUSY.has(s))
      if (busy && held === null) held = deps.start()
      else if (!busy) release()
    },
    active: () => held !== null,
    dispose: release
  }
}
