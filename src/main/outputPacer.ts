/**
 * Keeps a window that has fallen behind from being sent more terminal output than it can take. The host already slows
 * a program whose output main isn't reading; this carries that on to the window. Before, a window whose page was busy
 * for 5 s was still sent 31 MB of output in that time, which main held and the page then had to work through.
 *
 * The window says how much it has taken (see src/preload/outputAck.ts). When what it hasn't taken passes HIGH_WATER,
 * it's sent no more output, and what each session printed meanwhile is kept, up to KEEP_CHARS a session. Once it has
 * caught up to LOW_WATER, each session gets what it missed as one chunk, exactly, so a selection or a search in it is
 * left alone. Only a session that printed more than that while the window was behind gets its whole buffer from a
 * clean slate instead (ESC c and the buffer, as a view gets after the host reconnects), so it's shown right however much
 * it missed. That goes one session at a time, while the window keeps up.
 */

/** Characters of output sent to a window and not yet taken, past which it's sent no more. */
export const HIGH_WATER = 4 * 1024 * 1024
/** Back down to this, it's sent output again. */
export const LOW_WATER = 1024 * 1024
/** What a session's missed output is kept up to, while its window is behind. Past it, the view starts afresh. */
export const KEEP_CHARS = 256 * 1024
/** Clears a view's screen and history, ahead of the whole buffer. The same as backgroundHost's. */
const FULL_RESET = '\x1bc'

export interface PacedWindow {
  id: number
  send(channel: string, ...args: unknown[]): void
}

export interface OutputPacerOptions {
  /** The session's whole buffer and the count it's up to, for a window that missed some of it. */
  snapshot(id: string): { data: string; seq: number }
  /** Whether the window still shows the session, so is owed it. */
  wants(windowId: number, id: string): boolean
  highWater?: number
  lowWater?: number
  keepChars?: number
}

export interface OutputPacer {
  /** Sends a chunk of output to the window, unless it's behind. */
  deliver(win: PacedWindow, id: string, data: string, seq: number): void
  /** The window has taken this much output in all, counted in characters, since it loaded. */
  ack(win: PacedWindow, taken: number): void
  /** The window went, or loaded again and so starts its count from nothing. */
  forget(windowId: number): void
  /** For tests and the log: how far behind a window is, and whether it's held. */
  state(windowId: number): { unacked: number; held: boolean; missed: number } | null
}

/** What a session printed while its window was held: the output itself, or null once that passed KEEP_CHARS. */
interface Missed {
  parts: string[] | null
  size: number
  seq: number
}

interface Pace {
  sent: number
  taken: number
  /** Sessions that had output while this window was held, in the order they had it. Null while it's not held. */
  missed: Map<string, Missed> | null
}

export function createOutputPacer(opts: OutputPacerOptions): OutputPacer {
  const high = opts.highWater ?? HIGH_WATER
  const low = opts.lowWater ?? LOW_WATER
  const keep = opts.keepChars ?? KEEP_CHARS
  const paces = new Map<number, Pace>()

  const paceOf = (windowId: number): Pace => {
    let pace = paces.get(windowId)
    if (!pace) paces.set(windowId, (pace = { sent: 0, taken: 0, missed: null }))
    return pace
  }

  const send = (win: PacedWindow, pace: Pace, id: string, data: string, seq: number): void => {
    win.send('pb:onOutput', id, data, seq)
    pace.sent += data.length
  }

  /** Brings missed sessions up to date one at a time, for as long as the window keeps up. */
  const catchUp = (win: PacedWindow, pace: Pace): void => {
    const missed = pace.missed
    if (!missed) return
    for (const [id, m] of missed) {
      if (pace.sent - pace.taken > high) return
      missed.delete(id)
      if (!opts.wants(win.id, id)) continue
      if (m.parts) {
        send(win, pace, id, m.parts.join(''), m.seq)
        continue
      }
      const { data, seq } = opts.snapshot(id)
      send(win, pace, id, `${FULL_RESET}${data}`, seq)
    }
    if (pace.sent - pace.taken > high) return
    pace.missed = null
  }

  return {
    deliver(win, id, data, seq) {
      const pace = paceOf(win.id)
      if (pace.missed) {
        const m = pace.missed.get(id) ?? { parts: [], size: 0, seq }
        pace.missed.set(id, m)
        m.seq = seq
        m.size += data.length
        if (m.parts && m.size <= keep) m.parts.push(data)
        else m.parts = null
        return
      }
      send(win, pace, id, data, seq)
      if (pace.sent - pace.taken > high) pace.missed = new Map()
    },

    ack(win, taken) {
      const pace = paces.get(win.id)
      if (!pace || !Number.isFinite(taken) || taken <= pace.taken) return
      // Never more than was sent: a page can't take what it wasn't given.
      pace.taken = Math.min(taken, pace.sent)
      if (pace.missed && pace.sent - pace.taken <= low) catchUp(win, pace)
    },

    forget(windowId) {
      paces.delete(windowId)
    },

    state(windowId) {
      const pace = paces.get(windowId)
      return pace ? { unacked: pace.sent - pace.taken, held: pace.missed !== null, missed: pace.missed?.size ?? 0 } : null
    }
  }
}
