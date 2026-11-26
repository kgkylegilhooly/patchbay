import { modelNameOf, startModeOf } from '../../shared/startMode'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { runProgram } from '../../core/git/run'
import type { SessionSpec } from '../../shared/contract'
import { AGENT_NAMES, type AgentKind, type ClaudeNode } from '../../shared/model'
import { needsTerminal } from '../../shared/settings'
import { cleanEnv } from './env'
import { httpHooksBlocked, withLoopbackNoProxy } from './httpHookSafety'
import { settingsFileFor } from './sessionSettingsFiles'
import { nativeMessagingSettings } from './nativeMessaging'
import { signalFile, SIGNAL_EVENTS, statusFile } from './signals'

export interface ClaudeProgram {
  file: string
  prefixArgs: string[]
}

export interface SessionEnvContext {
  cliDir: string
  endpointFile: string
  /** Defaults to this process's environment. */
  baseEnv?: NodeJS.ProcessEnv
}

export interface ClaudeLaunchContext extends SessionEnvContext {
  sessionDir: string
  hookScript: string
  /** Reports usage, then draws the owner's own status line. */
  statusLineScript?: string
  /**
   * Where the busiest hooks and the status line leave their news as files, written by bash built-ins rather than by
   * starting Node. Set only where Claude Code runs its commands through Git Bash. See signals.ts.
   */
  signalDir?: string
  /** Where to find the owner's own settings. Defaults to their home folder, and is only ever read. */
  home?: string
  pluginDir: string
  token: string
  /** Defaults to resolveClaude(). */
  claude?: ClaudeProgram
  permissionMode?: string
  claudeTerminal?: string
  claudeCommand?: string
  /** The claudeNativeMessaging setting: 'on' lets the node use Claude's own messaging between sessions. */
  claudeNativeMessaging?: string
  /**
   * The node.exe for Claude to start each Node hook with directly, with no shell in between. Unset keeps the hook a
   * command line, for a Claude too old for that. See hookRunner.ts.
   */
  hookNode?: string | null
  /**
   * The session host's hook port. Set, every hook but SessionStart is an http hook to it, and starts no process. Only
   * for a session that runs in that host, with a Claude that has http hooks. See docs/plans/host-hooks.md.
   */
  hookPort?: number
  /** Where an administrator's Claude settings are. Defaults to the Windows location. For tests. */
  managedSettingsFile?: string
}

export interface ClaudeLaunch extends SessionSpec {
  sessionId: string
  resumed: boolean
  /** To type in once Claude is ready, rather than risk a shell reading it from the command line. */
  typedPrompt?: string
}

/**
 * A command hook's limit in seconds. Once it runs, hook.cjs gives up within 1.5 s, so this only has to cover starting
 * it: on a PC short of memory, with several agents, a shell and Node took past the 5 s this used to be, and Claude then
 * showed the person a red "timed out" line and lost the event. 30 s is Claude Code's own default for UserPromptSubmit.
 */
export const HOOK_TIMEOUT_S = 30
/** Claude waits this long for SessionEnd hooks as it quits, so a slow start can't make /exit seem to hang for long. */
export const SESSION_END_TIMEOUT_S = 10
/** A held permission request needs longer than the approvals hold of 540 s. */
export const HELD_HOOK_TIMEOUT_S = 600
/**
 * No PreToolUse: it ran before every tool call, and nothing needs it. Every status it could set, PostToolUse sets as
 * the call ends, and a permission prompt answered in the terminal still comes back to working with PostToolUse.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'Notification',
  'SessionEnd'
]

const CMD_META = /([()\][%!^"`<>&|;, *?])/g
const isCmd = (file: string): boolean => /^cmd(\.exe)?$/i.test(basename(file))

/** Written once for cmd.exe's single pass over the command name. */
function cmdEscapeCommand(path: string): string {
  return path.replace(CMD_META, '^$1')
}

/**
 * Quotes for the target program's argv parser, then caret-escapes twice: cmd.exe consumes one layer
 * reading our line, and a second reading the `%*` inside the batch file. Every quote is escaped too,
 * so cmd.exe never enters a quoted state where carets would stop working.
 */
function cmdEscapeArg(arg: string, layers: 1 | 2 = 2): string {
  const flat = arg.replace(/\r?\n/g, ' ') // cmd.exe ends the command at a newline, with no way to escape it
  const quoted = `"${flat.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  const once = quoted.replace(CMD_META, '^$1')
  return layers === 1 ? once : once.replace(CMD_META, '^$1')
}

/** How to run the Claude program at this path. A batch file can only run through cmd.exe. */
export function claudeAt(path: string): ClaudeProgram {
  if (!/\.(cmd|bat)$/i.test(path)) return { file: path, prefixArgs: [] }
  return { file: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', cmdEscapeCommand(path)] }
}

/** node-pty needs a full path with the right extension, so ask Windows for it. */
function whereIs(name: string): string | null {
  let lines: string[]
  try {
    lines = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch {
    return null
  }
  return pickWhere(lines)
}

/** The answer where.exe gave that a program can be started from. */
function pickWhere(lines: string[]): string | null {
  const pick = (ext: RegExp): string | undefined => lines.find((l) => ext.test(l))
  return pick(/\.exe$/i) ?? pick(/\.(cmd|bat)$/i) ?? lines[0] ?? null
}

/**
 * Asks where.exe about the programs agents start with, ahead of time and off the main thread, so the first agent
 * started finds them known. Asking as it starts makes the main process wait for where.exe to finish, which on a busy
 * PC took long enough to hold up the window. Nothing changes when a program isn't found: it's asked about then.
 */
export async function lookUpClaudeAhead(setting: { terminal?: string; command?: string }): Promise<void> {
  const names = new Set(['claude'])
  const first = (line?: string): string | undefined => (line?.trim() ? programWords(line)[0] : undefined)
  for (const name of [first(setting.command), first(setting.terminal)]) if (name && !/[\\/]/.test(name)) names.add(name)
  await Promise.all([...names].map((name) => (whereAnswers.has(name.toLowerCase()) ? null : askWhere(name))))
}

const asking = new Map<string, Promise<string | null>>()

/** where.exe's answer for a program, asked off the main thread. A program found is remembered; one not found isn't. */
function askWhere(name: string): Promise<string | null> {
  const key = name.toLowerCase()
  const already = asking.get(key)
  if (already) return already
  const ask = runProgram('where.exe', [name], { env: process.env as Record<string, string>, timeoutMs: 15_000, maxBytes: 64 * 1024 })
    .then((r) => {
      const path = r.code === 0 ? pickWhere(r.stdout.split(/\r?\n/).filter(Boolean)) : null
      if (path) whereAnswers.set(key, { path, at: Date.now() })
      if (path && key === 'claude' && !located && /\.(exe|cmd|bat)$/i.test(path)) located = path
      return path
    })
    .finally(() => asking.delete(key))
  asking.set(key, ask)
  return ask
}

/**
 * Whether the program a command line starts can be found, asked off the main thread. For the New form's warning before
 * Start (docs/plans/r3-start.md), so it says nothing a launch wouldn't: the same words are looked up the same way.
 */
export async function commandFound(line: string): Promise<boolean> {
  const [word] = programWords(line)
  if (!word) return false
  if (/[\\/]/.test(word)) return existsSync(word)
  const known = whereAnswers.get(word.toLowerCase())
  if (known?.path && existsSync(known.path)) return true
  return !!(await askWhere(word))
}

/** resolveClaude without waiting on where.exe on the main thread, for checks in the background. */
export async function resolveClaudeAsync(): Promise<ClaudeProgram> {
  if (located && existsSync(located)) return claudeAt(located)
  const path = await askWhere('claude')
  if (!path || !/\.(exe|cmd|bat)$/i.test(path)) throw new Error('The claude command was not found on PATH.')
  located = path
  return claudeAt(path)
}

let located: string | null = null

export function resolveClaude(): ClaudeProgram {
  if (located && existsSync(located)) return claudeAt(located)
  located = whereIs('claude')
  if (!located || !/\.(exe|cmd|bat)$/i.test(located)) {
    located = null
    throw new Error('The claude command was not found on PATH.')
  }
  return claudeAt(located)
}

export function programArgs(claude: ClaudeProgram, args: string[]): string[] {
  if (!isCmd(claude.file)) return [...claude.prefixArgs, ...args]
  const [d, s, c, command] = claude.prefixArgs
  // /s strips the outer quotes and leaves the rest exactly as written.
  return [d, s, c, `"${[command, ...args.map((a) => cmdEscapeArg(a))].join(' ')}"`]
}

/** Splits on spaces outside double quotes. Backslashes are ordinary characters, as in a Windows path. */
export function splitCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

/** A browsed path can hold spaces with no quotes around it, so the whole line is tried as a path first. */
function programWords(line: string): string[] {
  const trimmed = line.trim()
  return existsSync(trimmed) ? [trimmed] : splitCommand(trimmed)
}

type Find = (name: string) => string | null

/**
 * Recent answers from where.exe. Asking takes the main process a moment each time, and reopening ten agents with a
 * custom command asked ten times in a row. A program that's moved or gone since is asked about again.
 */
const whereAnswers = new Map<string, { path: string | null; at: number }>()
const LOCATED_KEPT_MS = 5 * 60_000

function locate(name: string): string | null {
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null
  const known = whereAnswers.get(name.toLowerCase())
  if (known?.path && existsSync(known.path)) {
    // An older answer still stands while it's asked again in the background, rather than waiting on where.exe here.
    if (Date.now() - known.at >= LOCATED_KEPT_MS) void askWhere(name).catch(() => null)
    return known.path
  }
  const path = whereIs(name)
  whereAnswers.set(name.toLowerCase(), { path, at: Date.now() })
  return path
}

/** Every argument stays one literal argument: nothing in a prompt can run as a shell command. */
function posixQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * PowerShell also ends a single-quoted string at curly quotes. Windows PowerShell hands programs their
 * arguments without escaping double quotes, so those are escaped here. PowerShell 7 does it itself.
 */
function powershellQuote(arg: string, windowsPowerShell: boolean): string {
  let text = arg
  if (windowsPowerShell) {
    text = text.replace(/(\\*)"/g, '$1$1\\"')
    if (/\s/.test(text)) text = text.replace(/(\\*)$/, '$1$1')
  }
  return `'${text.replace(/['‘’‚‛]/g, '$&$&')}'`
}

/** A batch file reads its arguments twice and a program once. When it's unclear, twice can't run anything. */
function cmdLayers(command: string, find: Find): 1 | 2 {
  const lastStep = command.split('{args}')[0].split(/&&|\|\||[&|]/).pop() ?? ''
  const word = splitCommand(lastStep)[0]
  return word && /\.exe$/i.test(find(word) ?? '') ? 1 : 2
}

function withArgs(command: string, args: string[], quote: (arg: string) => string): string {
  const joined = args.map(quote).join(' ')
  return command.includes('{args}') ? command.replace(/\{args\}/g, () => joined) : `${command} ${joined}`
}

/** Runs the command through the chosen terminal, which ends when the command does, so the node shows it stopped. */
function throughTerminal(terminal: string, command: string, args: string[], find: Find): { file: string; args: string[] } {
  const [name, ...extra] = programWords(terminal)
  const file = find(name)
  if (!file) throw new Error(`The terminal program "${name}" was not found. Check it in Settings.`)
  if (!/\.exe$/i.test(file)) throw new Error(`The terminal program has to be a .exe file, and "${file}" is not. Check it in Settings.`)
  const shell = basename(file).toLowerCase().replace(/\.exe$/, '')
  if (shell === 'cmd') {
    const layers = cmdLayers(command, find)
    return { file, args: [...extra, '/s', '/c', `"${withArgs(command, args, (a) => cmdEscapeArg(a, layers))}"`] }
  }
  if (shell === 'powershell' || shell === 'pwsh') {
    const line = withArgs(command, args, (a) => powershellQuote(a, shell === 'powershell'))
    // A quoted path on its own is only a string to PowerShell, so the call operator has to run it.
    return { file, args: [...extra, '-NoLogo', '-Command', /^\s*["']/.test(line) ? `& ${line}` : line] }
  }
  const line = withArgs(command, args, posixQuote)
  return { file, args: shell === 'bash' ? [...extra, '--login', '-i', '-c', line] : [...extra, '-c', line] }
}

function directly(command: string, args: string[], find: Find, name = 'Claude'): { file: string; args: string[] } {
  if (needsTerminal(command)) throw new Error(`This ${name} command needs a shell to run. Choose a terminal program in Settings.`)
  const [word, ...extra] = programWords(command)
  const path = find(word)
  if (!path) throw new Error(`The ${name} command "${word}" was not found. Check it in Settings.`)
  if (!/\.(exe|cmd|bat)$/i.test(path)) throw new Error(`Windows can't start "${path}" by itself. Choose the terminal program that runs it in Settings.`)
  const at = extra.indexOf('{args}')
  const all = at === -1 ? [...extra, ...args] : [...extra.slice(0, at), ...args, ...extra.slice(at + 1)]
  const claude = claudeAt(path)
  return { file: claude.file, args: programArgs(claude, all) }
}

/**
 * How to run an agent when Settings changes it. `find` is replaceable for tests. `agent` names it in what's said when
 * it can't start, and picks the program run when no command is set.
 */
export function customLaunch(setting: { terminal?: string; command?: string; agent?: AgentKind }, args: string[], find: Find = locate): { file: string; args: string[] } {
  const command = setting.command?.trim() || (setting.agent === 'codex' ? 'codex' : 'claude')
  const name = AGENT_NAMES[setting.agent ?? 'claude']
  return setting.terminal?.trim() ? throughTerminal(setting.terminal, command, args, find) : directly(command, args, find, name)
}

/** The environment every session gets, so the patchbay CLI works in any of them. */
export function sessionEnv(nodeId: string, token: string, ctx: SessionEnvContext): Record<string, string> {
  const base = ctx.baseEnv ?? process.env
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === 'PATH')
  const inherited = pathKey ? base[pathKey] : undefined
  return cleanEnv(base, {
    PATCHBAY_NODE_ID: nodeId,
    PATCHBAY_TOKEN: token,
    PATCHBAY_ENDPOINT_FILE: ctx.endpointFile,
    PATH: inherited ? `${ctx.cliDir}${delimiter}${inherited}` : ctx.cliDir
  })
}

export interface UserStatusLine {
  command: string
  padding?: number
}

/** The status line Claude would use if Patchbay set none, by Claude's own order of precedence. */
export function findUserStatusLine(cwd: string, home: string): UserStatusLine | null {
  const files = [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), join(home, '.claude', 'settings.json')]
  for (const file of files) {
    try {
      const line = JSON.parse(readFileSync(file, 'utf8'))?.statusLine
      if (typeof line?.command !== 'string' || !line.command) continue
      return { command: line.command, ...(typeof line.padding === 'number' ? { padding: line.padding } : {}) }
    } catch {
      // A missing or broken file means Claude wouldn't get a status line from it either.
    }
  }
  return null
}

/** A path as one bash word, in forward slashes, which Git Bash takes as they are. */
export function bashWord(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

/**
 * The command for one hook event. With a folder to signal through, the busiest ones only touch a file there: a bash
 * built-in, so nothing else starts. They leave their input unread, as Claude Code allows any hook to.
 */
export function hookCommand(event: string, nodeId: string, ctx: ClaudeLaunchContext): string {
  if (ctx.signalDir && (SIGNAL_EVENTS as readonly string[]).includes(event)) return `: > ${bashWord(signalFile(ctx.signalDir, nodeId, event))}`
  return `node "${ctx.hookScript.replace(/\\/g, '/')}" ${event}`
}

export interface CommandHook {
  type: 'command'
  command: string
  args?: string[]
  timeout: number
}

export interface HttpHook {
  type: 'http'
  url: string
  headers: Record<string, string>
  timeout: number
}

/**
 * An event posted straight to the session host: nothing starts. Claude Code allows only command hooks on SessionStart,
 * so that one stays a command (hook.cjs, to the app), which also returns the agent's context.
 *
 * The node and its token are written as they are, not as `$PATCHBAY_TOKEN` for Claude to fill in: Claude blanks
 * credential-like variables in hook headers when it scrubs its subprocesses' environment, and a managed
 * httpHookAllowedEnvVars can leave them out, and either would refuse every event. The file is the session's own, in the
 * same profile folder as the secret every token comes from, and the agent has the token in its environment anyway.
 */
export function httpHook(event: string, port: number, timeout: number, nodeId: string, token: string): HttpHook {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/hook/${event}`,
    headers: { authorization: `Bearer ${token}`, 'x-patchbay-node': nodeId },
    timeout
  }
}

/**
 * One hook event's entry in the settings. With a Node to start, Claude starts it directly: no Git Bash or PowerShell in
 * front of it, which roughly halves what each event costs, and saves most on a busy PC. See hookRunner.ts.
 *
 * Every event still runs to its end before Claude goes on. Run in the background ("async"), a turn's Stop and the next
 * prompt could arrive the wrong way round, and the node would show the wrong status.
 */
export function hookEntry(event: string, nodeId: string, ctx: ClaudeLaunchContext): CommandHook | HttpHook {
  const timeout = event === 'PermissionRequest' ? HELD_HOOK_TIMEOUT_S : event === 'SessionEnd' ? SESSION_END_TIMEOUT_S : HOOK_TIMEOUT_S
  if (ctx.hookPort && event !== 'SessionStart') return httpHook(event, ctx.hookPort, timeout, nodeId, ctx.token)
  const signalled = !!ctx.signalDir && (SIGNAL_EVENTS as readonly string[]).includes(event)
  if (!ctx.hookNode || signalled) return { type: 'command', command: hookCommand(event, nodeId, ctx), timeout }
  return { type: 'command', command: ctx.hookNode, args: [ctx.hookScript, event], timeout }
}

/**
 * The status line. With a folder to signal through, bash saves its input there for Patchbay to read, then runs the
 * owner's own status line on the same input, as Claude would have: none of Patchbay's Node, and no second bash.
 */
export function statusLineCommand(nodeId: string, ctx: ClaudeLaunchContext, own: UserStatusLine | null): string | null {
  if (!ctx.statusLineScript) return null
  if (!ctx.signalDir) return `node "${ctx.statusLineScript.replace(/\\/g, '/')}"`
  const save = `IFS= read -r -d '' j; printf '%s' "$j" > ${bashWord(statusFile(ctx.signalDir, nodeId))}`
  if (!own) return save
  // Claude reruns a status line up to three times a second while it works, and an owner's line is often a Node script,
  // whose start costs more than the rest of this together. What it last printed is shown again for up to a second, from
  // a file whose first line is when it ran, in microseconds. Everything here but the owner's own command is built in.
  const cache = bashWord(`${statusFile(ctx.signalDir, nodeId)}.line`)
  return [
    save,
    // Some locales write the time with a comma.
    'n=${EPOCHREALTIME/[.,]/}; t=; o=',
    `{ IFS= read -r t && IFS= read -r -d '' o; } 2>/dev/null < ${cache}`,
    `if [[ $t =~ ^[0-9]+$ ]] && (( n - t < ${OWN_LINE_REUSE_US} )); then printf '%s' "$o"; else o=$(eval "$PATCHBAY_STATUSLINE_FORWARD" <<< "$j"); printf '%s\\n%s' "$n" "$o" > ${cache}; printf '%s' "$o"; fi`
  ].join('; ')
}

/** How long an owner's status line is shown again rather than run again. */
const OWN_LINE_REUSE_US = 1_000_000

function writeSettings(node: ClaudeNode, ctx: ClaudeLaunchContext, own: UserStatusLine | null): string {
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [hookEntry(event, node.id, ctx)]
        }
      ]
    ])
  )
  mkdirSync(ctx.sessionDir, { recursive: true })
  // It goes with the node: see sessionSettingsFiles.ts.
  const file = settingsFileFor(ctx.sessionDir, node.id)
  const command = statusLineCommand(node.id, ctx, own)
  const statusLine = command ? { statusLine: { type: 'command', command, ...(own?.padding === undefined ? {} : { padding: own.padding }) } } : {}
  const dataDir = dirname(ctx.sessionDir)
  const messaging = nativeMessagingSettings(ctx.claudeNativeMessaging)
  const permissions = {
    allow: patchbayPermissions([ctx.pluginDir, join(dataDir, 'whiteboards'), join(dataDir, 'browser-shots')]),
    ...(messaging.deny.length ? { deny: messaging.deny } : {})
  }
  const inbound = messaging.crossSessionInbound ? { crossSessionInbound: messaging.crossSessionInbound } : {}
  writeFileSync(file, JSON.stringify({ hooks, ...statusLine, permissions, ...inbound }, null, 2))
  return file
}

/** The `patchbay` verbs that only look: nothing they do changes the canvas, sends anything or runs anything. */
export const LOOKING_VERBS = ['whoami', 'list', 'read', 'wait', 'whiteboard', 'issues', 'prs', 'guide', 'files', 'team']

/** A Windows path as Claude Code matches it in a rule: C:\Users\me becomes //c/Users/me. */
export function rulePath(path: string): string {
  const posix = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(posix)
  return drive ? `//${drive[1].toLowerCase()}${drive[2] ?? ''}` : posix.startsWith('/') ? `/${posix}` : posix
}

/**
 * What an agent may do without asking, on top of the person's own rules: read Patchbay's skill and the pictures it
 * exports, and run the verbs that only look. Without these, an agent opening the skill's reference files or a
 * whiteboard it exported, or asking `patchbay whoami`, stopped at a permission prompt each time. Everything that
 * changes or sends anything still asks, and the person's own deny rules still win.
 */
export function patchbayPermissions(readable: string[]): string[] {
  return [...readable.map((dir) => `Read(${rulePath(dir)}/**)`), ...LOOKING_VERBS.flatMap((verb) => [`Bash(patchbay ${verb})`, `Bash(patchbay ${verb} *)`])]
}

function defaultLaunch(ctx: ClaudeLaunchContext, args: string[]): { file: string; args: string[] } {
  const claude = ctx.claude ?? resolveClaude()
  return { file: claude.file, args: programArgs(claude, args) }
}

/** Writes the node's hook settings and describes how to launch it. The caller stores `sessionId`. */
export function buildClaudeLaunch(node: ClaudeNode, ctx: ClaudeLaunchContext): ClaudeLaunch {
  const resumed = !!node.sessionId
  const sessionId = node.sessionId ?? randomUUID()
  const own = ctx.statusLineScript ? findUserStatusLine(node.cwd, ctx.home ?? homedir()) : null
  // http hooks only where they'd reach the host directly. See httpHookSafety.ts.
  const configDir = Object.entries(ctx.baseEnv ?? process.env).find(([k]) => k.toUpperCase() === 'CLAUDE_CONFIG_DIR')?.[1]
  const hookPort = ctx.hookPort && !httpHooksBlocked({ cwd: node.cwd, home: ctx.home ?? homedir(), configDir, managedFile: ctx.managedSettingsFile }) ? ctx.hookPort : undefined
  const args = ['--settings', writeSettings(node, { ...ctx, hookPort }, own), '--plugin-dir', ctx.pluginDir]
  // Its own mode, set in the form, over the global one (F61). Only the fixed modes count, and never bypass.
  const mode = startModeOf(node.startMode) ?? ctx.permissionMode
  if (mode) args.push('--permission-mode', mode)
  const model = modelNameOf(node.model)
  if (model) args.push('--model', model)
  if (resumed) {
    args.push('--resume', sessionId)
  } else {
    args.push('--session-id', sessionId)
    // A shell can read a command line differently from what it hands on: Git Bash rewrites /init into a path, and a
    // batch file behind PowerShell or cmd can run part of it. Typing the prompt can't be misread by any of them.
    if (node.prompt?.trim() && !ctx.claudeTerminal) args.push('--', node.prompt)
  }
  const program = ctx.claudeTerminal || ctx.claudeCommand ? customLaunch({ terminal: ctx.claudeTerminal, command: ctx.claudeCommand }, args) : defaultLaunch(ctx, args)
  return {
    nodeId: node.id,
    ...program,
    cwd: node.cwd,
    env: {
      // Its hooks go to 127.0.0.1, never through a proxy.
      ...(hookPort ? withLoopbackNoProxy(sessionEnv(node.id, ctx.token, ctx)) : sessionEnv(node.id, ctx.token, ctx)),
      ...(own ? { PATCHBAY_STATUSLINE_FORWARD: own.command } : {})
    },
    ...(hookPort ? { hookPort } : {}),
    sessionId,
    resumed,
    ...(!resumed && ctx.claudeTerminal && node.prompt?.trim() ? { typedPrompt: node.prompt } : {})
  }
}
