import type { CanvasDoc, TriggerEventSource, TriggerLimits, TriggerNode, TriggerPreflight, TriggerSchedule } from '../../shared/model'

/**
 * Triggers that fire when something happens on this PC rather than at a time. Everything here is pure, so the form, the
 * node and the main process judge a trigger the same way. See docs/plans/event-triggers.md.
 */

export const DEFAULT_QUIET_MS = 5000
export const MIN_QUIET_MS = 1000
export const MAX_QUIET_MS = 10 * 60_000
export const DEFAULT_LIMITS: TriggerLimits = { gapMs: 30_000, perHour: 10 }
export const MIN_GAP_MS = 5000
export const MAX_GAP_MS = 24 * 3_600_000
export const MAX_PER_HOUR = 60
/** Only so many file names go into a prompt. The count says how many there were. */
export const MAX_FILES_LISTED = 20
/** A preflight that hasn't finished by then counts as failed, and is ended. */
export const PREFLIGHT_TIMEOUT_MS = 2 * 60_000
/** How much of a preflight's output the run history keeps: the end, where a check says what went wrong. */
export const PREFLIGHT_TAIL_CHARS = 400

export function isEventSchedule(s: TriggerSchedule): s is TriggerEventSource {
  return s.type === 'agent' || s.type === 'run' || s.type === 'files'
}

/** The node an event comes from, for agent and run kinds. */
export function sourceNodeId(s: TriggerSchedule): string | null {
  return s.type === 'agent' || s.type === 'run' ? s.nodeId : null
}

/** What an event firing must pass. Schedule triggers have none: their schedule paces them. */
export function limitsOf(node: Pick<TriggerNode, 'schedule' | 'limits'>): TriggerLimits | null {
  return isEventSchedule(node.schedule) ? (node.limits ?? DEFAULT_LIMITS) : null
}

// ---------------------------------------------------------------------------------------------------------------------
// Placeholders

export const PLACEHOLDERS: Record<TriggerEventSource['type'], string[]> = {
  agent: ['node', 'event', 'time'],
  run: ['node', 'event', 'exitCode', 'time'],
  files: ['files', 'folder', 'event', 'time']
}

const PLACEHOLDER = /\\\{\{|\{\{([A-Za-z]+)\}\}/g

/** Placeholder names a prompt uses, in order, without repeats. `\{{` is a literal `{{` and names nothing. */
export function placeholdersIn(prompt: string): string[] {
  const names = new Set<string>()
  for (const m of prompt.matchAll(PLACEHOLDER)) if (m[1]) names.add(m[1])
  return [...names]
}

/** Why the prompt's placeholders don't fit the trigger's kind, or null. */
export function placeholderProblem(prompt: string, s: TriggerSchedule): string | null {
  if (!isEventSchedule(s)) return null
  const allowed = PLACEHOLDERS[s.type]
  const unknown = placeholdersIn(prompt).filter((n) => !allowed.includes(n))
  if (!unknown.length) return null
  return `This kind of trigger has no ${unknown.map((n) => `{{${n}}}`).join(', ')}. It can use ${allowed.map((n) => `{{${n}}}`).join(', ')}. Write \\{{ for a literal {{.`
}

/**
 * Fills placeholders in one pass: a value is never read again, so a file named `{{node}}` stays as it is. `\{{` becomes
 * `{{`. A name with no value becomes empty.
 */
export function expandPrompt(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(PLACEHOLDER, (whole, name: string | undefined) => (name === undefined ? '{{' : Object.hasOwn(vars, name) ? vars[name] : whole))
}

/** What happened, as the trigger service reports it. */
export type TriggerEvent =
  | { type: 'agent'; nodeTitle: string; on: 'turn' | 'needs-you' | 'exit' }
  | { type: 'run'; nodeTitle: string; exitCode: number }
  | { type: 'files'; folder: string; files: string[]; total: number }

const AGENT_EVENT: Record<'turn' | 'needs-you' | 'exit', string> = { turn: 'finished a turn', 'needs-you': 'needs you', exit: 'exited' }

/** One line saying what happened, for the run history and {{event}}. */
export function describeEventHappened(e: TriggerEvent): string {
  switch (e.type) {
    case 'agent':
      return `"${e.nodeTitle}" ${AGENT_EVENT[e.on]}`
    case 'run':
      return `"${e.nodeTitle}" ${e.exitCode === 0 ? 'finished' : 'failed'} with exit code ${e.exitCode}`
    case 'files':
      return `${e.total} file${e.total === 1 ? '' : 's'} changed in ${e.folder}`
  }
}

/**
 * A value typed into a terminal goes to a shell, so a file named `x; rm -rf ~` must not run anything. Only letters,
 * digits, spaces and `. _ / \ : , @ + = -` stay. Quotes are dropped and anything else becomes `_`.
 */
export function terminalSafe(value: string): string {
  return value.replace(/["']/g, '').replace(/[^A-Za-z0-9 ._/\\:,@+=-]/g, '_')
}

/** Values for an event's placeholders. Fired by hand there's no event, so they say so or are empty. */
export function eventVars(e: TriggerEvent | null, at: number): Record<string, string> {
  const base = { time: new Date(at).toLocaleString(), event: e ? describeEventHappened(e) : 'run by hand' }
  if (!e) return { ...base, node: '', exitCode: '', files: '', folder: '' }
  if (e.type === 'agent') return { ...base, node: e.nodeTitle }
  if (e.type === 'run') return { ...base, node: e.nodeTitle, exitCode: String(e.exitCode) }
  const more = e.total - e.files.length
  return { ...base, folder: e.folder, files: e.files.join(', ') + (more > 0 ? ` and ${more} more` : '') }
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths and globs. No node:path here: the form runs in the page.

const slashes = (p: string): string => p.replace(/\\/g, '/')

export function isAbsoluteFolder(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

/** A comparable form: forward slashes, no trailing slash, and on Windows any case. */
export function folderKey(p: string): string {
  const s = slashes(p.trim()).replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) || s.startsWith('//') ? s.toLowerCase() : s
}

export function isInside(folder: string, root: string): boolean {
  const f = folderKey(folder)
  const r = folderKey(root)
  if (!r) return false
  return f === r || f.startsWith(`${r}/`)
}

/** Folders a trigger in this project may watch or run a check in: the project's, its worktrees', its sessions'. */
export function projectRoots(doc: Pick<CanvasDoc, 'nodes' | 'projects'>, projectId: string | undefined): string[] {
  const roots = new Set<string>()
  const project = doc.projects.find((p) => p.id === projectId)
  if (project?.folder) roots.add(project.folder)
  for (const n of doc.nodes) {
    if (n.projectId !== projectId) continue
    if (n.kind === 'group' && n.worktree) roots.add(n.worktree.path)
    if ((n.kind === 'terminal' || n.kind === 'claude' || n.kind === 'run') && n.cwd && !(n.kind === 'terminal' && n.sshHost)) roots.add(n.cwd)
  }
  return [...roots]
}

/** Why this folder can't be used by a trigger in that project, or null. */
export function folderProblem(folder: string, roots: string[], what: string): string | null {
  if (!folder.trim()) return `Choose the folder ${what}.`
  if (!isAbsoluteFolder(folder)) return `The folder ${what} must be a full path.`
  if (slashes(folder).split('/').includes('..')) return `The folder ${what} can't use "..".`
  if (!roots.some((r) => isInside(folder, r))) return `The folder ${what} must be inside the project: its folder, a worktree or a session's folder.`
  return null
}

/** Paths under these are never watched: they change all the time and nobody means them. */
export function ignoredPath(rel: string): boolean {
  return slashes(rel)
    .split('/')
    .some((seg) => seg === '.git' || seg === 'node_modules')
}

const escapeRe = (c: string): string => c.replace(/[.+^$()|[\]\\]/g, '\\$&')

/** `**`, `*`, `?` and `{a,b}`. Null if the braces don't balance. */
export function globToRegExp(glob: string): RegExp | null {
  const g = slashes(glob.trim()).replace(/^\.\//, '')
  let re = ''
  let depth = 0
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      depth++
      re += '(?:'
    } else if (c === '}' && depth > 0) {
      depth--
      re += ')'
    } else if (c === ',' && depth > 0) re += '|'
    else re += escapeRe(c)
  }
  return depth === 0 ? new RegExp(`^${re}$`, 'i') : null
}

/** A glob with no `/` matches a file's name at any depth; one with `/` matches its path from the watched folder. */
export function matchesGlob(rel: string, glob: string): boolean {
  const re = globToRegExp(glob)
  if (!re) return false
  const path = slashes(rel).replace(/^\.\//, '')
  return re.test(slashes(glob).includes('/') ? path : (path.split('/').pop() ?? path))
}

// ---------------------------------------------------------------------------------------------------------------------
// Preflight

/** Splits a preflight command into arguments. It never goes through a shell, so shell syntax is refused. */
export function preflightArgv(text: string): { ok: true; argv: string[] | null } | { ok: false; reason: string } {
  const t = text.trim()
  if (!t) return { ok: true, argv: null }
  if (/["'`$&|<>;()%^!\r\n]/.test(t)) return { ok: false, reason: 'The check runs without a shell, so it can\'t use quotes, pipes, && or variables. Name a script instead, such as "npm test".' }
  return { ok: true, argv: t.split(/\s+/) }
}

export function preflightText(p: TriggerPreflight | null | undefined): string {
  return p ? p.argv.join(' ') : ''
}

/** The end of a check's output, one line per line, for the run history. Colours and other terminal codes are dropped. */
export function outputTail(text: string): string {
  const t = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim()
  return t.length > PREFLIGHT_TAIL_CHARS ? `…${t.slice(-PREFLIGHT_TAIL_CHARS)}` : t
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking and describing

/** What's wrong with an event kind on its own, without looking at the canvas. */
export function eventShapeError(s: TriggerEventSource): string | null {
  switch (s.type) {
    case 'agent':
      return s.nodeId ? null : 'Choose the agent it watches.'
    case 'run':
      return s.nodeId ? null : 'Choose the run node it watches.'
    case 'files':
      if (!s.glob.trim()) return 'Give a pattern for the files, such as **/*.ts.'
      if (!globToRegExp(s.glob)) return 'The file pattern has a { without its }.'
      if (!Number.isFinite(s.quietMs) || s.quietMs < MIN_QUIET_MS || s.quietMs > MAX_QUIET_MS) return `The quiet time must be from ${MIN_QUIET_MS / 1000} seconds to ${MAX_QUIET_MS / 60_000} minutes.`
      return null
  }
}

export function limitsError(l: TriggerLimits | undefined): string | null {
  if (!l) return null
  if (!Number.isFinite(l.gapMs) || l.gapMs < MIN_GAP_MS || l.gapMs > MAX_GAP_MS) return `The gap between firings must be at least ${MIN_GAP_MS / 1000} seconds, and at most a day.`
  if (!Number.isInteger(l.perHour) || l.perHour < 1 || l.perHour > MAX_PER_HOUR) return `It can fire from 1 to ${MAX_PER_HOUR} times an hour.`
  return null
}

/** Why this trigger's event, check and limits can't be armed as they are on this canvas, or null. */
export function eventRefusal(node: TriggerNode, doc: Pick<CanvasDoc, 'nodes' | 'projects'>): string | null {
  const s = node.schedule
  const roots = projectRoots(doc, node.projectId)
  if (isEventSchedule(s)) {
    const shape = eventShapeError(s)
    if (shape) return shape
    if (s.type === 'agent' || s.type === 'run') {
      const source = doc.nodes.find((n) => n.id === s.nodeId)
      if (s.type === 'agent' && source?.kind !== 'claude') return 'The agent it watches is gone. Choose another.'
      if (s.type === 'run' && source?.kind !== 'run') return 'The run node it watches is gone. Choose another.'
      if (source!.projectId !== node.projectId) return 'What it watches is in another project.'
    } else {
      const problem = folderProblem(s.folder, roots, 'it watches')
      if (problem) return problem
    }
    const limits = limitsError(node.limits)
    if (limits) return limits
  }
  if (node.preflight) {
    if (!node.preflight.argv.length || node.preflight.argv.some((a) => !a)) return 'The check before firing has no command.'
    const problem = folderProblem(node.preflight.cwd, roots, 'the check runs in')
    if (problem) return problem
  }
  return placeholderProblem(node.prompt, s)
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

export function describeSeconds(ms: number): string {
  return ms % 60_000 === 0 ? plural(ms / 60_000, 'minute') : plural(Math.round(ms / 100) / 10, 'second')
}

/** Says exactly what the event is. `name` gives a node's title, when the canvas is at hand. */
export function describeEvent(s: TriggerEventSource, name: (id: string) => string | undefined = () => undefined): string {
  switch (s.type) {
    case 'agent': {
      const who = name(s.nodeId) ?? 'an agent that is gone'
      return `When "${who}" ${s.on === 'turn' ? 'finishes a turn' : s.on === 'needs-you' ? 'needs you' : 'exits'}`
    }
    case 'run': {
      const who = name(s.nodeId) ?? 'a run node that is gone'
      return `When "${who}" ${s.failedOnly ? 'fails (non-zero exit)' : 'finishes'}`
    }
    case 'files':
      return `When files matching ${s.glob.trim()} change in ${s.folder}, after ${describeSeconds(s.quietMs)} quiet`
  }
}

export function describeLimits(l: TriggerLimits): string {
  return `At most once every ${describeSeconds(l.gapMs)}, and ${plural(l.perHour, 'time')} an hour`
}
