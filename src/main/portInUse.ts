import { stripAnsi } from '../core/transcript/read'

/**
 * F68: "port 3000 is in use". A dev server that fails because its port is taken left the person hunting for the
 * window already serving it. A run's or terminal's new output is read for that error, once per start; the window's
 * strip then names the session `ports` says holds the port (see renderer/nodes/PortInUseStrip.tsx).
 */

/** Raw output kept from the last chunk, so an error split between two chunks is still found. */
const CARRY = 200

/** The error as servers print it: Node's EADDRINUSE, "address already in use", Windows' 10048, a strict "Port N is already in use". */
const IN_USE = /EADDRINUSE|address already in use|only one usage of each socket address|\bport \d{2,5} is already in use/i

/** The port the error line names: the last ":N" on it, or "port N". */
function portOf(line: string): number | null {
  const named = /\bport (\d{2,5})\b/i.exec(line)
  const colons = [...line.matchAll(/:(\d{2,5})\b/g)]
  const text = named?.[1] ?? colons.at(-1)?.[1]
  const port = text ? Number(text) : NaN
  return port >= 1 && port <= 65535 ? port : null
}

/** The error, with the port it names when it names one, or null when the text isn't that error. */
export function portInUseIn(text: string): { port: number | null } | null {
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (IN_USE.test(line)) return { port: portOf(line) }
  }
  return null
}

export function createPortInUseWatch(d: { found: (nodeId: string, port: number | null) => void }) {
  const tails = new Map<string, string>()
  const reported = new Set<string>()
  return {
    /** New output from a run or terminal window. */
    output(nodeId: string, data: string): void {
      if (reported.has(nodeId)) return
      const seen = (tails.get(nodeId) ?? '') + data
      const hit = portInUseIn(seen)
      if (hit) {
        reported.add(nodeId)
        tails.delete(nodeId)
        d.found(nodeId, hit.port)
        return
      }
      tails.set(nodeId, seen.slice(-CARRY))
    },
    /** The window started again, or was closed: a new error is news again. */
    reset(nodeId: string): void {
      reported.delete(nodeId)
      tails.delete(nodeId)
    }
  }
}
