import { open, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProgram } from '../../core/git/run'
import { type SessionLine, sessionHooks } from '../../core/diagnostics/report'
import { agentChoice } from '../../shared/agents'
import type { AgentProgramInfo } from '../../shared/diagnostics'
import { AGENT_NAMES, agentOf, type AgentKind, type CanvasNode } from '../../shared/model'
import type { Settings } from '../../shared/settings'
import { agentProgramProblem } from '../sessions/agentProgramCheck'
import { resolveClaudeAsync, type ClaudeProgram, programArgs } from '../sessions/claudeLaunch'
import { resolveCodexAsync } from '../sessions/codexLaunch'
import { claudeVersion } from '../sessions/hookRunner'
import { loadRegistryPolicy, MANAGED_FILE, registryPolicyNow, type RegistryPolicy } from '../sessions/httpHookSafety'
import { settingsFileFor } from '../sessions/sessionSettingsFiles'

/** The path a program was found at: a batch file runs through cmd.exe, with its path, escaped, after /c. */
export function programPath(p: ClaudeProgram): string {
  return p.prefixArgs.length >= 4 ? p.prefixArgs[3].replace(/\^(.)/g, '$1') : p.file
}

/** One answer per Codex program and app run. Codex prints "codex-cli 0.150.0". */
const codexVersions = new Map<string, Promise<string | null>>()

function codexVersion(codex: ClaudeProgram): Promise<string | null> {
  const args = programArgs(codex, ['--version'])
  const key = [codex.file, ...args].join('\0')
  let known = codexVersions.get(key)
  if (!known) {
    // Through runProgram, so it starts off the main thread, as Claude's version question does.
    known = runProgram(codex.file, args, { env: process.env as Record<string, string>, timeoutMs: 15_000, maxBytes: 64 * 1024, verbatim: codex.prefixArgs.length > 0 }).then(
      (r) => /(\d+\.\d+\.\d+[\w.-]*)/.exec(r.stdout)?.[1] ?? null,
      () => null
    )
    codexVersions.set(key, known)
  }
  return known
}

/**
 * Each enabled agent's program and version. Only a program Patchbay found on PATH is asked: a command or terminal
 * program from Settings is never run just to ask, as hookRunner.ts explains, so it's named instead.
 */
export async function agentPrograms(settings: Settings): Promise<AgentProgramInfo[]> {
  const one = async (kind: AgentKind): Promise<AgentProgramInfo> => {
    const name = AGENT_NAMES[kind]
    const problem = (await agentProgramProblem(kind, settings).catch(() => null)) ?? undefined
    const terminal = kind === 'claude' ? settings.claudeTerminal?.trim() : ''
    const command = (kind === 'claude' ? settings.claudeCommand : settings.codexCommand)?.trim()
    if (terminal) return { kind, name, program: `${terminal} running ${command || kind}`, version: 'not asked (runs in a terminal program)', problem }
    if (command) return { kind, name, program: command, version: 'not asked (custom command)', problem }
    try {
      const program = await (kind === 'claude' ? resolveClaudeAsync() : resolveCodexAsync())
      const version = kind === 'claude' ? (await claudeVersion({ claude: program }))?.join('.') : await codexVersion(program)
      return { kind, name, program: programPath(program), version: version ?? 'version unknown', problem }
    } catch {
      return { kind, name, program: null, version: 'not found', problem }
    }
  }
  return Promise.all(agentChoice(settings).enabled.map(one))
}

/** The last bytes of the log, enough for its last few dozen lines. Read without holding up anything. */
export async function readLogEnd(file: string, bytes = 64 * 1024): Promise<string> {
  const handle = await open(file, 'r').catch(() => null)
  if (!handle) return ''
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await handle.read(buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    // A partial first line is dropped.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

/** Running sessions, with each Claude's hook setup read from the settings file it was started with. */
export async function sessionLines(d: {
  nodes: CanvasNode[]
  isRunning(id: string): boolean
  status(id: string): string
  sessionDir: string
  /** Sessions the host runs that no node shows. */
  hosted?: Array<{ id: string; running: boolean }>
}): Promise<SessionLine[]> {
  const lines = await Promise.all(
    d.nodes.map(async (n): Promise<SessionLine | null> => {
      if ((n.kind !== 'claude' && n.kind !== 'terminal' && n.kind !== 'run') || !d.isRunning(n.id)) return null
      // Only agents have a status beyond running.
      if (n.kind !== 'claude') return { id: n.id, kind: n.kind, status: 'running' }
      const agent = agentOf(n)
      const hooks = agent === 'claude' ? sessionHooks((await readFile(settingsFileFor(d.sessionDir, n.id), 'utf8').catch(() => '')) || '') : undefined
      return { id: n.id, kind: 'agent', agent, status: d.status(n.id), hooks }
    })
  )
  const known = new Set(d.nodes.map((n) => n.id))
  const unseen = (d.hosted ?? []).filter((s) => s.running && !known.has(s.id)).map((s): SessionLine => ({ id: s.id, kind: 'unknown', status: 'no node' }))
  return [...lines.filter((l): l is SessionLine => l !== null), ...unseen]
}

/**
 * Signs in a Claude settings file that it runs Patchbay's hooks or status line: they belong only in a session's own. A
 * hook of the person's own that merely reads PATCHBAY_NODE_ID isn't one.
 */
const PATCHBAY_HOOK = /hook\.cjs|statusline\.cjs|\/hook\//i

const namesPatchbayHooks = (settings: unknown): boolean => {
  const s = settings as { hooks?: unknown; statusLine?: unknown } | null
  return !!s && PATCHBAY_HOOK.test(JSON.stringify([s.hooks ?? null, s.statusLine ?? null]))
}

/**
 * Claude settings that any Claude would read, outside Patchbay too, which name Patchbay's hooks: the places
 * httpHookSafety.ts reads (managed settings, their drop-ins and the registry policy, the person's own, and each folder's).
 * Patchbay never writes them there (each session gets its own file through --settings), so one found means it was
 * copied in by hand, and a Claude in any terminal would run Patchbay's hooks. Only `hooks` and `statusLine` are looked at.
 */
export async function outsideHooks(places: { home: string; configDir?: string; folders: string[]; managedFile?: string; registry?: RegistryPolicy[] }): Promise<string[]> {
  const userDir = places.configDir || join(places.home, '.claude')
  const managed = places.managedFile ?? MANAGED_FILE
  const dropIns = join(dirname(managed), 'managed-settings.d')
  const dropInFiles = (await readdir(dropIns).catch(() => [] as string[]))
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => join(dropIns, n))
  const files = [
    managed,
    ...dropInFiles,
    join(userDir, 'settings.json'),
    join(userDir, 'settings.local.json'),
    ...[...new Set(places.folders.filter(Boolean))].flatMap((f) => [join(f, '.claude', 'settings.json'), join(f, '.claude', 'settings.local.json')])
  ]
  const found = await Promise.all(
    files.map(async (file) => {
      try {
        return namesPatchbayHooks(JSON.parse(await readFile(file, 'utf8'))) ? file : null
      } catch {
        return null
      }
    })
  )
  const registry = places.registry ?? (await loadRegistryPolicy().then(registryPolicyNow, () => []))
  return [...found.filter((f): f is string => f !== null), ...registry.filter((p) => namesPatchbayHooks(p.settings)).map((p) => p.key)]
}

export const logFolder = (logFile: string): string => dirname(logFile)
