import { createRingBuffer, utf8Tail } from './ringBuffer'

/**
 * Private modes a program turns on and expects to stay on. Once the start of a session's output has rolled
 * out of its buffer, nothing else would tell a new view about them: without 2004 a paste submits at its first
 * line break, and without 1049 a full-screen program draws over the shell's history.
 */
const TRACKED_MODES = new Set([1, 7, 12, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049, 2004])
/** These are on until a program says otherwise, so only turning them off needs replaying. */
const ON_BY_DEFAULT = new Set([7, 25])
const ALT_SCREEN = [47, 1047, 1049]
const MODE_SET = /\x1b\[\?([\d;]+)([hl])/g
/** The longest tail of a chunk that could be the start of a mode sequence cut in two. */
const CARRY_CHARS = 32

export interface ModeTracker {
  feed(data: string): void
  /** Sequences that bring a fresh terminal to the same modes. */
  replay(): string
  altScreen(): boolean
}

export function createModeTracker(): ModeTracker {
  const modes = new Map<number, boolean>()
  let carry = ''

  return {
    feed(data) {
      const text = carry + data
      carry = ''
      for (const match of text.matchAll(MODE_SET)) {
        for (const part of match[1].split(';')) {
          const mode = Number(part)
          if (TRACKED_MODES.has(mode)) modes.set(mode, match[2] === 'h')
        }
      }
      const lastEsc = text.lastIndexOf('\x1b')
      if (lastEsc !== -1 && text.length - lastEsc < CARRY_CHARS && /^\x1b(\[(\?[\d;]*)?)?$/.test(text.slice(lastEsc))) carry = text.slice(lastEsc)
    },
    replay() {
      let out = ''
      for (const [mode, on] of [...modes].sort((a, b) => a[0] - b[0])) {
        if (on !== ON_BY_DEFAULT.has(mode)) out += `\x1b[?${mode}${on ? 'h' : 'l'}`
      }
      return out
    },
    altScreen: () => ALT_SCREEN.some((mode) => modes.get(mode))
  }
}

/**
 * Queries a terminal answers by typing into the session: device attributes, status and cursor reports, mode
 * and setting requests, and color queries. Live, the program is waiting for the answer. Replayed later, the
 * answer would arrive at a shell prompt as stray typed text, so saved output never carries them.
 */
const TERMINAL_QUERIES = new RegExp(
  [
    '\\x1b\\[[>=]?\\d*c', // Device attributes.
    '\\x1b\\[\\??\\d*n', // Status and cursor position reports.
    '\\x1b\\[\\??\\d+\\$p', // Mode requests.
    '\\x1b\\[>\\d*q', // Terminal version.
    '\\x1b\\](?:4;\\d+|1[0-9]);\\?(?:\\x07|\\x1b\\\\)', // Color queries.
    '\\x1bP(?:\\$q|\\+q)[^\\x1b]*\\x1b\\\\' // Setting and capability requests.
  ].join('|'),
  'g'
)

export function stripTerminalQueries(data: string): string {
  return data.replace(TERMINAL_QUERIES, '')
}

/** Rolled-out output can leave half an escape sequence at the start. How far to look for a clean place to begin. */
const CLEAN_START_CHARS = 256

function cleanStart(data: string): string {
  const head = data.slice(0, CLEAN_START_CHARS)
  const at = head.search(/[\x1b\n]/)
  return at > 0 ? data.slice(at) : data
}

export interface SessionBuffer {
  append(text: string): void
  /** What a new view should replay. Safe to feed to a terminal that's connected to the live session. */
  read(): string
  altScreen(): boolean
}

/** A session's newest output, readable at any time as something a brand-new terminal can show correctly. */
export function createSessionBuffer(capBytes: number, seed = ''): SessionBuffer {
  const ring = createRingBuffer(capBytes, seed)
  const modes = createModeTracker()
  modes.feed(seed)

  return {
    append(text) {
      modes.feed(text)
      ring.append(text)
    },
    read() {
      const raw = ring.read()
      if (!ring.wrapped()) return stripTerminalQueries(raw)
      // The whole read stays within the cap, so a store that keeps only the tail of anything bigger can never
      // cut off the modes at the front, which are the part a wrapped buffer most needs.
      const prefix = modes.replay()
      const room = Math.max(0, capBytes - Buffer.byteLength(prefix))
      return stripTerminalQueries(`${prefix}${cleanStart(utf8Tail(raw, room))}`)
    },
    altScreen: () => modes.altScreen()
  }
}
