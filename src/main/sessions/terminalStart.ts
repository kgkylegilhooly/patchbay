import type { SessionHost } from '../../shared/contract'
import type { Settings } from '../../shared/settings'
import { detectBuiltInProfiles, terminalLaunch, terminalProfiles, type TerminalLaunch } from './shell'
import type { TerminalProfile } from '../../shared/terminalProfiles'

/** After output stops this long, the shell is taken to be at its prompt. */
export const PROMPT_QUIET_MS = 400
/** A shell that says nothing at all still gets its startup command after this long. */
export const PROMPT_WAIT_MAX_MS = 8000
/** Bash turns bracketed paste on when its line editor is ready for a command. */
const PASTE_ON = '\x1b[?2004h'

/** What a terminal node starts, read from settings at each launch so a saved change applies to the next one. */
export function terminalStartFor(
  ctx: { settings?: () => Settings; shell?: string; builtInProfiles?: () => TerminalProfile[] },
  node: { profile?: unknown; command?: string },
  restored: boolean
): TerminalLaunch {
  const settings: Settings = { ...(ctx.shell ? { shell: ctx.shell } : {}), ...ctx.settings?.() }
  const list = terminalProfiles(settings, (ctx.builtInProfiles ?? detectBuiltInProfiles)())
  return terminalLaunch(list, node, restored)
}

/** The line a node shows when the profile it was opened with has gone. */
export function missingProfileNotice(name: string): string {
  return `\x1b[33mThe terminal profile this window was opened with has been deleted, so it started with the default, ${name}.\x1b[0m\r\n`
}

export interface StartupTyper {
  /**
   * Types these lines once the session reaches its first prompt. With promptSignOnly, only bash's own sign that its
   * prompt is ready counts, not quiet, since a slow login script can pause before it.
   */
  arm(id: string, lines: string[], opts?: { promptSignOnly?: boolean }): void
  output(id: string, data: string): void
  /** The session ended, or is starting again: nothing waits for it any more. */
  cancel(id: string): void
}

/**
 * Types a terminal's startup lines once, at its first prompt: as soon as bash says its line editor is ready, or once
 * any shell has printed something and gone quiet, or, for one that prints nothing, after a while regardless. Typed,
 * not passed as arguments, so they work with any program and whatever arguments a profile gives it.
 */
export function createStartupTyper({
  host,
  prefix,
  quietMs = PROMPT_QUIET_MS,
  maxMs = PROMPT_WAIT_MAX_MS
}: {
  host: Pick<SessionHost, 'write' | 'isRunning'>
  prefix?: (id: string) => string
  quietMs?: number
  maxMs?: number
}): StartupTyper {
  const waiting = new Map<string, { lines: string[]; signOnly: boolean; quiet?: NodeJS.Timeout; cap: NodeJS.Timeout }>()

  const cancel = (id: string): void => {
    const w = waiting.get(id)
    if (!w) return
    clearTimeout(w.quiet)
    clearTimeout(w.cap)
    waiting.delete(id)
  }

  const type = (id: string): void => {
    const w = waiting.get(id)
    if (!w) return
    cancel(id)
    if (!host.isRunning(id)) return
    host.write(id, (prefix?.(id) ?? '') + w.lines.map((l) => `${l}\r`).join(''))
  }

  return {
    arm(id, lines, opts) {
      cancel(id)
      if (!lines.length) return
      const cap = setTimeout(() => type(id), maxMs)
      cap.unref?.()
      waiting.set(id, { lines, signOnly: !!opts?.promptSignOnly, cap })
    },
    output(id, data) {
      const w = waiting.get(id)
      if (!w) return
      if (data.includes(PASTE_ON)) return type(id)
      if (w.signOnly) return
      clearTimeout(w.quiet)
      w.quiet = setTimeout(() => type(id), quietMs)
      w.quiet.unref?.()
    },
    cancel
  }
}
