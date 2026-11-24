import type { AboutInfo, AgentProgramInfo } from '../../shared/diagnostics'

/**
 * The plain-text block Copy diagnostics puts on the clipboard, for a bug report. Pure, so what goes in it, and what
 * never does, can be tested without an app. See docs/plans/r5-diagnostics.md.
 *
 * Never in it: tokens, prompts, conversation text, node titles (often made from a prompt) or the person's user name.
 */

/** How a hook event reaches Patchbay, as a session's settings file has it. See hookEntry in claudeLaunch.ts. */
export type HookMode = 'http' | 'exec' | 'command' | 'signal'

export interface HookSetup {
  mode: HookMode
  /** Seconds, as Claude Code was told. Null when the file names none, which means Claude's own default. */
  timeout: number | null
}

/** The hook setup a Claude session runs with, read from the settings file it was started with. */
export interface SessionHooks {
  prompt: HookSetup | null
  start: HookSetup | null
}

function setupOf(entry: unknown): HookSetup | null {
  const hook = (entry as { hooks?: unknown[] } | undefined)?.hooks?.[0] as { type?: unknown; command?: unknown; args?: unknown; timeout?: unknown } | undefined
  if (!hook || typeof hook !== 'object') return null
  const timeout = typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) ? hook.timeout : null
  if (hook.type === 'http') return { mode: 'http', timeout }
  if (hook.type !== 'command') return null
  if (Array.isArray(hook.args)) return { mode: 'exec', timeout }
  // The busiest events only touch a file, with a bash built-in. See signals.ts.
  if (typeof hook.command === 'string' && hook.command.startsWith(': >')) return { mode: 'signal', timeout }
  return { mode: 'command', timeout }
}

/**
 * UserPromptSubmit's setup, the hook bug reports name ("UserPromptSubmit hook timed out after 5s"), and SessionStart's,
 * which is never http. Only the type, the presence of `args` and the timeout are read: never a header, which holds the
 * node's token. Null for a file that can't be read as settings.
 */
export function sessionHooks(settingsText: string): SessionHooks | null {
  let hooks: Record<string, unknown[]> | undefined
  try {
    hooks = (JSON.parse(settingsText) as { hooks?: Record<string, unknown[]> } | null)?.hooks
  } catch {
    return null
  }
  if (!hooks || typeof hooks !== 'object') return null
  return { prompt: setupOf(hooks.UserPromptSubmit?.[0]), start: setupOf(hooks.SessionStart?.[0]) }
}

const setupText = (s: HookSetup | null): string => (s ? `${s.mode}${s.timeout === null ? '' : ` ${s.timeout} s`}` : 'none')

export function hooksText(h: SessionHooks | null): string {
  if (!h) return 'settings file unreadable'
  return `UserPromptSubmit ${setupText(h.prompt)}, SessionStart ${setupText(h.start)}`
}

/** The user-name part of a home folder, "C:\\Users\\name" giving "name". */
export function userNameOf(home: string): string | null {
  const m = /[\\/]Users[\\/]([^\\/]+)[\\/]?$/i.exec(home)
  return m ? m[1] : null
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Hides who the person is, and anything secret that slipped into a line. The home folder, in either slash and any case,
 * and any other `\Users\<name>`, become `\Users\<you>`, and the user name standing alone too (a log line can name it
 * outside a path). A bearer token, or a value given for something called a token, secret, key or password, becomes
 * `<hidden>`.
 */
export function redact(text: string, home: string | null): string {
  let out = text
  const name = home ? userNameOf(home) : null
  if (home && name) {
    // The whole home first, so a name with a space in it goes in one piece.
    const parent = home.replace(/[\\/]+$/, '').slice(0, -name.length)
    for (const sep of ['\\', '/']) {
      const form = parent.replace(/[\\/]/g, sep)
      out = out.replace(new RegExp(`${escapeRe(form)}${escapeRe(name)}(?=$|[\\\\/\\s"'])`, 'gim'), (m) => `${m.slice(0, m.length - name.length)}<you>`)
    }
  }
  out = out.replace(/([\\/]Users[\\/])(?!<you>)[^\\/\s"'<>|:*?]+/gi, '$1<you>')
  // A short name like "me" or "dev" would match ordinary words, so only a name of 3 or more letters alone is hidden.
  if (name && name.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'gi'), '<you>')
  return out
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <hidden>')
    .replace(/\b([A-Za-z_]*(?:token|secret|password|api[_-]?key)[A-Za-z_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2<hidden>')
}

/** Memory readings fill the log every half hour and say nothing about a fault, so they're left out. */
const MEMORY_LINE = /^\S+\s+Memory:/

/** The last `count` lines of the log that aren't memory readings, oldest first. */
export function logTail(text: string, count = 40): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !MEMORY_LINE.test(l))
    .slice(-count)
}

export interface SessionLine {
  id: string
  kind: string
  status: string
  agent?: 'claude' | 'codex'
  /** For a running Claude: the hooks it was started with. */
  hooks?: SessionHooks | null
}

/** "agent: 2 working, 1 idle; terminal: 3 running", by kind then status, in a stable order. */
export function statusCounts(sessions: ReadonlyArray<{ kind: string; status: string }>): string {
  if (!sessions.length) return 'none'
  const byKind = new Map<string, Map<string, number>>()
  for (const s of sessions) {
    const statuses = byKind.get(s.kind) ?? new Map<string, number>()
    statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1)
    byKind.set(s.kind, statuses)
  }
  return [...byKind]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, statuses]) => `${kind}: ${[...statuses].sort(([a], [b]) => a.localeCompare(b)).map(([status, n]) => `${n} ${status}`).join(', ')}`)
    .join('; ')
}

const MB = 1024 * 1024
const mb = (bytes: number): string => `${Math.round(bytes / MB)} MB`
const gb = (bytes: number): string => `${(bytes / (1024 * MB)).toFixed(1)} GB`

export interface MemoryReading {
  system: { totalPhys: number; availPhys: number; commitLimit: number; commitAvail: number } | null
  app: { total: number }
  host: { memory: number | null } | null
}

export function memoryLines(m: MemoryReading): string[] {
  const lines: string[] = []
  if (m.system) {
    const { totalPhys, availPhys, commitLimit, commitAvail } = m.system
    lines.push(`RAM: ${gb(totalPhys - availPhys)} used of ${gb(totalPhys)}`)
    if (commitLimit > 0) lines.push(`Commit: ${gb(commitLimit - commitAvail)} of ${gb(commitLimit)} (${Math.round(((commitLimit - commitAvail) / commitLimit) * 100)}%)`)
  } else lines.push('RAM: unknown')
  lines.push(`Patchbay: ${mb(m.app.total)}${m.host ? `, session host ${m.host.memory === null ? 'not read yet' : mb(m.host.memory)}` : ''}`)
  return lines
}

export interface HostLine {
  mode: string
  pid?: number
  version?: string
  protocol?: number
  expectedProtocol: number
  running: number
  startedAt?: number
  problem?: string
}

export interface DiagnosticsInput {
  about: AboutInfo
  /** When it was made, as an ISO time. */
  at: string
  agents: AgentProgramInfo[]
  /** The agent settings that change how Claude is started: a terminal program or a command in place of `claude`. */
  launch: { claudeTerminal?: string; claudeCommand?: string; codexCommand?: string }
  host: HostLine
  sessions: SessionLine[]
  memory: MemoryReading | null
  /** Claude settings files outside Patchbay that name Patchbay's hook script or host. See outsideHooks in collect.ts. */
  outsideHooks: string[]
  log: string[]
  home: string
}

function buildText(b: AboutInfo['build']): string {
  const commit = b.commit === 'unknown' ? 'commit unknown' : `commit ${b.commit}${b.dirty ? ' with changes' : ''}${b.branch && b.branch !== 'HEAD' ? ` on ${b.branch}` : ''}`
  return `${commit}, built ${b.date}`
}

/** The whole block, redacted. */
export function diagnosticsText(d: DiagnosticsInput): string {
  const a = d.about
  const lines: string[] = [
    'Patchbay diagnostics',
    `Made: ${d.at}`,
    '',
    `Patchbay ${a.version} (${buildText(a.build)})`,
    `Electron ${a.electron}, Node ${a.node}, Chromium ${a.chrome}`,
    `OS: ${a.os}`,
    '',
    'Agents:'
  ]
  for (const g of d.agents) lines.push(`- ${g.name}${/^\d/.test(g.version) ? ' ' : ', '}${g.version}: ${g.program ?? 'not found'}${g.problem ? ` (${g.problem})` : ''}`)
  if (!d.agents.length) lines.push('- none enabled')
  if (d.launch.claudeTerminal?.trim()) lines.push(`Claude runs inside: ${d.launch.claudeTerminal.trim()}`)
  if (d.launch.claudeCommand?.trim()) lines.push(`Claude command: ${d.launch.claudeCommand.trim()}`)
  if (d.launch.codexCommand?.trim()) lines.push(`Codex command: ${d.launch.codexCommand.trim()}`)
  const h = d.host
  lines.push(
    '',
    `Session host: ${h.mode}${h.pid ? `, pid ${h.pid}` : ''}${h.version ? `, version ${h.version}` : ''}, protocol ${h.protocol ?? '?'} (app expects ${h.expectedProtocol}), ${h.running} running${h.startedAt ? `, started ${new Date(h.startedAt).toISOString()}` : ''}`
  )
  if (h.problem) lines.push(`Host problem: ${h.problem}`)
  lines.push(`Sessions: ${statusCounts(d.sessions)}`)
  const claudes = d.sessions.filter((s) => s.kind === 'agent')
  if (claudes.length) {
    lines.push('Agent sessions (first 8 of node id):')
    for (const s of claudes) lines.push(`- ${s.id.slice(0, 8)} ${s.agent ?? 'claude'} ${s.status}: ${s.agent === 'codex' ? "hooks in Codex's own config" : hooksText(s.hooks ?? null)}`)
  }
  lines.push('', ...(d.memory ? memoryLines(d.memory) : ['Memory: not read']))
  lines.push('', `Claude settings outside Patchbay naming its hooks: ${d.outsideHooks.length ? d.outsideHooks.join(', ') : 'none'}`)
  lines.push('', `Log, last ${d.log.length} lines (memory readings left out):`, ...d.log)
  return redact(lines.join('\n'), d.home)
}
