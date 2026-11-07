export interface AttachGate {
  chunk(data: string, seq: number): void
  snapshot(s: { data: string; seq: number }): void
}

/**
 * Joins a snapshot to the live stream with nothing lost or repeated. Subscribe first and attach
 * second: chunks that arrive before the snapshot wait here, and any the snapshot already holds drop.
 */
export function createAttachGate(write: (data: string) => void): AttachGate {
  let held: Array<{ data: string; seq: number }> | null = []
  let floor = 0

  return {
    chunk(data, seq) {
      if (held) held.push({ data, seq })
      else if (seq > floor) write(data)
    },
    snapshot(s) {
      if (!held) return
      const waiting = held
      held = null
      floor = s.seq
      if (s.data) write(s.data)
      for (const c of waiting) if (c.seq > floor) write(c.data)
    }
  }
}
