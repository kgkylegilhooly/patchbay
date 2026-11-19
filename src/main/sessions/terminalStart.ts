import type { SessionHost } from '../../shared/contract'
import type { Settings } from '../../shared/settings'
import { stripAnsi } from '../../core/transcript/read'
import { detectBuiltInProfiles, terminalLaunch, terminalProfiles, type PromptWait, type TerminalLaunch } from './shell'
import type { TerminalProfile } from '../../shared/terminalProfiles'

/** After output stops this long on a line that looks like a prompt, the shell is taken to be at its prompt. */
export const PROMPT_QUIET_MS = 400
/** After this long with no prompt, the window says its startup command is still waiting. Nothing is typed blind. */
export const PROMPT_WAIT_MAX_MS = 8000
/** Bash turns bracketed paste on when its line editor is ready for a command. */
const PASTE_ON = '\x1b[?2004h'
/** How much of the screen is kept to judge the last line by. */
const SCREEN_CHARS = 400

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

/** What a node shows when the profile it was opened with has gone. */
export function missingProfileNotice(name: string): string {
  return `The terminal profile this window was opened with has been deleted, so it started with the default, ${name}.`
}

/** What a node shows while its startup command waits for a prompt that hasn't come. */
export const STARTUP_WAITING = "This terminal's startup command hasn't been typed, because no shell prompt has appeared yet. It's typed when one does."

/** What a node shows when the person typed first, so its startup command was left out. */
export function startupSkipped(lines: string[]): string {
  return `This terminal's startup command wasn't typed, because you typed first: ${lines.join(' ; ')}`
}

/** Whether the last line on screen ends the way a prompt does: PowerShell's and cmd's `>`, or a `$`, `#` or `%`. */
export function looksLikePrompt(screen: string): boolean {
  const lines = stripAnsi(screen).split(/\r?\n|\r/)
  const last = lines[lines.length - 1] ?? ''
  return /[>$#%]\s?$/.test(last)
}

export interface StartupTyper {
  /**
   * Types these lines once the session reaches its first prompt. 'sign' waits for bash's own sign that its line editor
   * is ready, since a login script can stop at a question. 'prompt' waits for output to go quiet on a line that looks
   * like a prompt.
   */
  arm(id: string, lines: string[], waitFor: PromptWait): void
  output(id: string, data: string): void
  /** Something was sent from the window. Real keys mean the person is using the prompt, so 'prompt' mode stands aside. */
  input(id: string, data: string): void
  /** The session ended, or is starting again: nothing waits for it any more. */
  cancel(id: string): void
}

export interface TyperEvents {
  /** It has waited a long while for a prompt, and is still waiting. */
  waiting?(id: string): void
  /** It typed the lines. */
  typed?(id: string): void
  /** The person typed first, so it gave up. */
  skipped?(id: string, lines: string[]): void
}

/**
 * What the window sends that nobody typed: replies to a program's questions about the terminal, focus changes and mouse
 * reports. The same list as sendGuard.ts.
 */
const NOT_TYPING = /\x1b\[[IO]|\x1b\[[0-9]+;[0-9]+R|\x1b\[[?>]?[0-9;]*c|\x1b\[<[0-9]+;[0-9]+;[0-9]+[Mm]|\x1b\[M[^]{3}|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * Types a terminal's startup lines once, at its first prompt. Typed, not passed as arguments, so they work with any
 * program and whatever arguments a profile gives it. Never typed blind: a shell that stops at a question (a passphrase,
 * a new WSL user's name) keeps them waiting, and the window says so.
 */
export function createStartupTyper({
  host,
  prefix,
  events = {},
  quietMs = PROMPT_QUIET_MS,
  maxMs = PROMPT_WAIT_MAX_MS
}: {
  host: Pick<SessionHost, 'write' | 'isRunning'>
  prefix?: (id: string) => string
  events?: TyperEvents
  quietMs?: number
  maxMs?: number
}): StartupTyper {
  const waiting = new Map<string, { lines: string[]; waitFor: PromptWait; screen: string; quiet?: NodeJS.Timeout; cap: NodeJS.Timeout }>()

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
    events.typed?.(id)
  }

  return {
    arm(id, lines, waitFor) {
      cancel(id)
      if (!lines.length) return
      const cap = setTimeout(() => {
        const w = waiting.get(id)
        if (!w) return
        if (w.waitFor === 'prompt' && looksLikePrompt(w.screen)) return type(id)
        events.waiting?.(id)
      }, maxMs)
      cap.unref?.()
      waiting.set(id, { lines, waitFor, screen: '', cap })
    },
    output(id, data) {
      const w = waiting.get(id)
      if (!w) return
      // The sign can arrive split across two chunks, so the end of the last one is kept.
      const seen = w.screen.slice(-(PASTE_ON.length - 1)) + data
      w.screen = (w.screen + data).slice(-SCREEN_CHARS)
      if (w.waitFor === 'sign') {
        // After the chunk has reached every listener, so the send guard has seen bash turn paste on and can put its
        // byte ahead of the line. See sendGuard.ts.
        if (seen.includes(PASTE_ON)) queueMicrotask(() => type(id))
        return
      }
      clearTimeout(w.quiet)
      w.quiet = setTimeout(() => {
        if (looksLikePrompt(w.screen)) type(id)
      }, quietMs)
      w.quiet.unref?.()
    },
    input(id, data) {
      const w = waiting.get(id)
      // Bash's sign only comes with an empty line, so in 'sign' mode keys typed before it (a passphrase) are no risk.
      if (!w || w.waitFor !== 'prompt' || !data.replace(NOT_TYPING, '')) return
      cancel(id)
      events.skipped?.(id, w.lines)
    },
    cancel
  }
}
