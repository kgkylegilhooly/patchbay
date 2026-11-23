/**
 * Keeps a window that has fallen behind from being sent more terminal output than it can take. The host already slows
 * a program whose output main isn't reading; this carries that on to the window. Before, a window whose page was busy
 * for 5 s was still sent 31 MB of output in that time, which main held and the page then had to work through.
 *
 * The window says how much it has taken (see src/preload/outputAck.ts). Sessions in the project on screen come first:
 * - Past HIGH_WATER untaken, background sessions (another project's, kept warm by the window for a while after a
 *   switch) are sent no more, so they can't push the ones on screen behind.
 * - Past HARD_WATER, which only the sessions on screen can reach by then, those are held too.
 * What a held session prints is kept, up to KEEP_CHARS. Once the window is back down to LOW_WATER, each held session
 * gets what it missed as one chunk, exactly, so a selection or a search in it is left alone; those on screen first, one
 * at a time while the window keeps up. Only a session that printed more than KEEP_CHARS meanwhile gets its whole buffer
 * from a clean slate instead (ESC c and the buffer, as a view gets after the host reconnects), so it's shown right
 * however much it missed. A session brought up to date in a catch-up is sent its output straight on until the round
 * ends, so a slow page never sees one session start afresh over and over.
 */

/** Characters of output sent to a window and not yet taken, past which background sessions are held. */
export const HIGH_WATER = 4 * 1024 * 1024
/** Past this, the sessions on screen are held too. */
export const HARD_WATER = 8 * 1024 * 1024
/** Back down to this, held sessions catch up. */
export const LOW_WATER = 1024 * 1024
/** What a session's missed output is kept up to, while it's held. Past it, the view starts afresh. */
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
  /** Whether the session is in the project on screen. Without this, every session is. */
  foreground?(id: string): boolean
  highWater?: number
  hardWater?: number
  lowWater?: number
  keepChars?: number
}

export interface OutputPacer {
  /** Sends a chunk of output to the window, unless the session is held. */
  deliver(win: PacedWindow, id: string, data: string, seq: number): void
  /** The window has taken this much output in all, counted in characters, since it loaded. */
  ack(win: PacedWindow, taken: number): void
  /** The window went, or loaded again and so starts its count from nothing. */
  forget(windowId: number): void
  /** For tests and the log: how far behind a window is, what's held, and how many sessions missed output. */
  state(windowId: number): { unacked: number; held: boolean; holding: 'none' | 'background' | 'all'; missed: number } | null
}

/** What a session printed while it was held: the output itself, or null once that passed KEEP_CHARS. */
interface Missed {
  parts: string[] | null
  size: number
  seq: number
  foreground: boolean
}

interface Pace {
  sent: number
  taken: number
  holding: 'none' | 'background' | 'all'
  /** Held sessions with output waiting, in the order they had it. A session here stays held until it's caught up. */
  missed: Map<string, Missed>
  /** Sessions already brought up to date in the catch-up under way. Null when none is. */
  caught: Set<string> | null
}

export function createOutputPacer(opts: OutputPacerOptions): OutputPacer {
  const high = opts.highWater ?? HIGH_WATER
  const hard = Math.max(high, opts.hardWater ?? HARD_WATER)
  const low = opts.lowWater ?? LOW_WATER
  const keep = opts.keepChars ?? KEEP_CHARS
  const foreground = opts.foreground ?? (() => true)
  const paces = new Map<number, Pace>()

  const paceOf = (windowId: number): Pace => {
    let pace = paces.get(windowId)
    if (!pace) paces.set(windowId, (pace = { sent: 0, taken: 0, holding: 'none', missed: new Map(), caught: null }))
    return pace
  }

  const behind = (pace: Pace): number => pace.sent - pace.taken

  const send = (win: PacedWindow, pace: Pace, id: string, data: string, seq: number): void => {
    win.send('pb:onOutput', id, data, seq)
    pace.sent += data.length
    if (behind(pace) > hard) pace.holding = 'all'
    else if (behind(pace) > high && pace.holding === 'none') pace.holding = 'background'
  }

  /** Brings held sessions up to date one at a time, those on screen first, for as long as the window keeps up. */
  const catchUp = (win: PacedWindow, pace: Pace): void => {
    pace.caught ??= new Set()
    const order = [...pace.missed].sort((a, b) => Number(b[1].foreground) - Number(a[1].foreground))
    for (const [id, m] of order) {
      if (behind(pace) > high) return
      pace.missed.delete(id)
      pace.caught.add(id)
      if (!opts.wants(win.id, id)) continue
      if (m.parts) {
        send(win, pace, id, m.parts.join(''), m.seq)
        continue
      }
      const { data, seq } = opts.snapshot(id)
      send(win, pace, id, `${FULL_RESET}${data}`, seq)
    }
  }

  return {
    deliver(win, id, data, seq) {
      const pace = paceOf(win.id)
      const front = foreground(id)
      const held = pace.missed.get(id)
      // Already up to date in this catch-up: on it goes, unless the page has stopped taking anything at all again.
      const caught = !held && pace.caught?.has(id) && behind(pace) <= hard + high
      if (!caught && (held || pace.holding === 'all' || (pace.holding === 'background' && !front))) {
        const m = held ?? { parts: [], size: 0, seq, foreground: front }
        pace.missed.set(id, m)
        m.seq = seq
        m.size += data.length
        m.foreground = front
        if (m.parts && m.size <= keep) m.parts.push(data)
        else m.parts = null
        return
      }
      send(win, pace, id, data, seq)
    },

    ack(win, taken) {
      const pace = paces.get(win.id)
      if (!pace || !Number.isFinite(taken) || taken <= pace.taken) return
      // Never more than was sent: a page can't take what it wasn't given.
      pace.taken = Math.min(taken, pace.sent)
      if (behind(pace) > low) return
      pace.holding = 'none'
      // The round ends once nothing is waiting and the window has taken what the round sent it.
      if (pace.missed.size) catchUp(win, pace)
      else pace.caught = null
    },

    forget(windowId) {
      paces.delete(windowId)
    },

    state(windowId) {
      const pace = paces.get(windowId)
      if (!pace) return null
      return { unacked: behind(pace), held: pace.holding !== 'none' || pace.missed.size > 0, holding: pace.holding, missed: pace.missed.size }
    }
  }
}
