import type { SessionHost, SessionSpec } from '../shared/contract'

interface EchoSession {
  data: string
  seq: number
}

/** A SessionHost that echoes input, so the canvas can run without real PTYs. */
export function createEchoSessionHost(): SessionHost {
  const sessions = new Map<string, EchoSession>()
  const outputListeners: Array<(id: string, data: string, seq: number) => void> = []
  const exitListeners: Array<(id: string, code: number) => void> = []

  return {
    pid: () => null,
    start(spec: SessionSpec): void {
      sessions.set(spec.nodeId, { data: spec.initialScrollback ?? '', seq: 0 })
    },
    write(id: string, data: string): void {
      const session = sessions.get(id)
      if (!session) return
      session.data += data
      session.seq += 1
      for (const cb of outputListeners) cb(id, data, session.seq)
    },
    resize(): void {},
    async kill(id: string): Promise<void> {
      if (!sessions.delete(id)) return
      for (const cb of exitListeners) cb(id, 0)
    },
    isRunning(id: string): boolean {
      return sessions.has(id)
    },
    snapshot(id: string): { data: string; seq: number } {
      const session = sessions.get(id)
      return session ? { data: session.data, seq: session.seq } : { data: '', seq: 0 }
    },
    onOutput(cb): void {
      outputListeners.push(cb)
    },
    onExit(cb): void {
      exitListeners.push(cb)
    }
  }
}
