import { basename } from 'node:path'
import { isFocusReport, SACRIFICE } from '../../shared/resizeGuard'

/**
 * The same guard as the window's (see shared/resizeGuard.ts), for text the main process types into a terminal: an
 * agent's `patchbay send`, or a trigger. After a resize, Git Bash dropped the first letter of every one of these, so
 * `npm test` arrived as `pm test`.
 *
 * Main has no screen to look at, so it goes by what bash itself says: bash turns bracketed paste on while its line
 * editor waits for a command and off to run one. The byte goes ahead only for a Git Bash terminal, resized since
 * anything was last typed, with bracketed paste on.
 */
export interface SendGuard {
  /** The terminal was resized. */
  resized(id: string): void
  /** Output from the session, to follow bracketed paste. */
  output(id: string, data: string): void
  /** Something was typed in the window. The window guards its own keys; this only notes that bash has read since. */
  typed(id: string, data: string): void
  /** What to put ahead of text main is about to type, which counts as typing. */
  prefixFor(id: string): string
  /** Whether the session's output last turned bracketed paste on or off. Undefined until it has said either. */
  pasteOn(id: string): boolean | undefined
  /**
   * The person has typed at this session's prompt and not sent it, so a message typed in now would join their text.
   * It lasts until they stop typing for a while, or shortly after Enter or Ctrl+C.
   */
  drafting(id: string): boolean
  /** A draft has ended, so what was held for it can go. */
  onDraftSettled(cb: (id: string) => void): void
  forget(id: string): void
}

/**
 * What the window passes on without anyone typing: the terminal's replies to a program's questions (cursor position,
 * device attributes, colors), focus changes and mouse reports.
 */
const NOT_TYPING = /\x1b\[[IO]|\x1b\[[0-9]+;[0-9]+R|\x1b\[[?>]?[0-9;]*c|\x1b\[<[0-9]+;[0-9]+;[0-9]+[Mm]|\x1b\[M[^]{3}|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** Git for Windows' bash, which has the bug. WSL's bash.exe in System32 is a Linux bash, which doesn't. */
export function isGitBashFile(file: string): boolean {
  return basename(file).toLowerCase() === 'bash.exe' && !/[\\/]system32[\\/]/i.test(file)
}

export function createSendGuard({
  isGitBash,
  draftQuietMs = 20_000,
  afterEnterMs = 3000
}: {
  isGitBash: (id: string) => boolean
  /** How long a half-typed prompt holds messages after the last key. */
  draftQuietMs?: number
  /** How long after Enter or Ctrl+C, for the agent's status to show it took what was sent. */
  afterEnterMs?: number
}): SendGuard {
  const resized = new Set<string>()
  const pasteOn = new Map<string, boolean>()
  const drafts = new Map<string, NodeJS.Timeout>()
  const settledListeners: Array<(id: string) => void> = []

  const hold = (id: string, ms: number): void => {
    clearTimeout(drafts.get(id))
    const timer = setTimeout(() => {
      drafts.delete(id)
      for (const cb of settledListeners) cb(id)
    }, ms)
    timer.unref?.()
    drafts.set(id, timer)
  }

  const noteDraft = (id: string, data: string): void => {
    const keys = data.replace(NOT_TYPING, '')
    if (!keys) return
    const sent = Math.max(keys.lastIndexOf('\r'), keys.lastIndexOf('\x03'))
    // Text after the last Enter is a new draft.
    hold(id, sent === -1 || sent < keys.length - 1 ? draftQuietMs : afterEnterMs)
  }

  return {
    resized: (id) => void resized.add(id),
    output(id, data) {
      const on = data.lastIndexOf('\x1b[?2004h')
      const off = data.lastIndexOf('\x1b[?2004l')
      if (on !== off) pasteOn.set(id, on > off)
    },
    typed(id, data) {
      if (!isFocusReport(data)) resized.delete(id)
      noteDraft(id, data)
    },
    prefixFor(id) {
      const was = resized.delete(id)
      return was && pasteOn.get(id) === true && isGitBash(id) ? SACRIFICE : ''
    },
    pasteOn: (id) => pasteOn.get(id),
    drafting: (id) => drafts.has(id),
    onDraftSettled: (cb) => void settledListeners.push(cb),
    forget(id) {
      resized.delete(id)
      pasteOn.delete(id)
      clearTimeout(drafts.get(id))
      drafts.delete(id)
    }
  }
}
