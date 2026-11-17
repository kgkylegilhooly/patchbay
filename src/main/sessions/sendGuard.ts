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
  forget(id: string): void
}

/** Git for Windows' bash, which has the bug. WSL's bash.exe in System32 is a Linux bash, which doesn't. */
export function isGitBashFile(file: string): boolean {
  return basename(file).toLowerCase() === 'bash.exe' && !/[\\/]system32[\\/]/i.test(file)
}

export function createSendGuard({ isGitBash }: { isGitBash: (id: string) => boolean }): SendGuard {
  const resized = new Set<string>()
  const pasteOn = new Map<string, boolean>()
  return {
    resized: (id) => void resized.add(id),
    output(id, data) {
      const on = data.lastIndexOf('\x1b[?2004h')
      const off = data.lastIndexOf('\x1b[?2004l')
      if (on !== off) pasteOn.set(id, on > off)
    },
    typed(id, data) {
      if (!isFocusReport(data)) resized.delete(id)
    },
    prefixFor(id) {
      const was = resized.delete(id)
      return was && pasteOn.get(id) === true && isGitBash(id) ? SACRIFICE : ''
    },
    forget(id) {
      resized.delete(id)
      pasteOn.delete(id)
    }
  }
}
