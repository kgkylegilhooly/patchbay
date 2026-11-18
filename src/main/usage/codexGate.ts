/**
 * Patchbay runs Codex itself now and then, to read its limits. A Codex session starting at the same moment, as when the
 * app reopens and restarts its agents, sets up Codex's database alongside it, and the session can crash on start
 * ("failed to migrate state DB"). This keeps the two apart: a starting session waits out a read in progress, and no
 * read begins for a while after a session starts.
 */
export interface CodexGate {
  /** A Codex session is about to start. Resolves once nothing of Patchbay's own is using Codex. */
  sessionStarting(): Promise<void>
  /** Runs the read, unless a session started too recently. Then it's skipped, and resolves to undefined. */
  read<T>(fn: () => Promise<T>): Promise<T | undefined>
  /** How long until a skipped read may run. */
  waitMs(): number
}

/** Long enough for Codex to have set up its database and settled. */
export const CODEX_SETTLE_MS = 20_000

export function createCodexGate({ settleMs = CODEX_SETTLE_MS, now = Date.now }: { settleMs?: number; now?: () => number } = {}): CodexGate {
  let reading: Promise<unknown> | null = null
  let startedAt = -Infinity

  return {
    async sessionStarting() {
      startedAt = now()
      await reading?.catch(() => {})
      // The settling time counts from when the session really starts.
      startedAt = now()
    },
    async read(fn) {
      if (now() - startedAt < settleMs) return undefined
      const running = fn()
      reading = running
      try {
        return await running
      } finally {
        if (reading === running) reading = null
      }
    },
    waitMs: () => Math.max(0, settleMs - (now() - startedAt))
  }
}
