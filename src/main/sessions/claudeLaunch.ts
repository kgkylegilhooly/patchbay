import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { SessionSpec } from '../../shared/contract'
import type { ClaudeNode } from '../../shared/model'
import { needsTerminal } from '../../shared/settings'
import { cleanEnv } from './env'

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
  /** Where to find the owner's own settings. Defaults to their home folder, and is only ever read. */
  home?: string
  pluginDir: string
  token: string
  /** Defaults to resolveClaude(). */
  claude?: ClaudeProgram
  permissionMode?: string
  claudeTerminal?: string
  claudeCommand?: string
}

export interface ClaudeLaunch extends SessionSpec {
  sessionId: string
  resumed: boolean
  /** To type in once Claude is ready, rather than risk a shell reading it from the command line. */
  typedPrompt?: string
}

/** A command hook's limit in seconds. hook.cjs exits long before this. */
const HOOK_TIMEOUT_S = 5
/** A held permission request needs longer than the approvals hold of 540 s. */
const HELD_HOOK_TIMEOUT_S = 600
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
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
  const pick = (ext: RegExp): string | undefined => lines.find((l) => ext.test(l))
  return pick(/\.exe$/i) ?? pick(/\.(cmd|bat)$/i) ?? lines[0] ?? null
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

function locate(name: string): string | null {
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null
  return whereIs(name)
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

function directly(command: string, args: string[], find: Find): { file: string; args: string[] } {
  if (needsTerminal(command)) throw new Error('This Claude command needs a shell to run. Choose a terminal program in Settings.')
  const [name, ...extra] = programWords(command)
  const path = find(name)
  if (!path) throw new Error(`The Claude command "${name}" was not found. Check it in Settings.`)
  if (!/\.(exe|cmd|bat)$/i.test(path)) throw new Error(`Windows can't start "${path}" by itself. Choose the terminal program that runs it in Settings.`)
  const at = extra.indexOf('{args}')
  const all = at === -1 ? [...extra, ...args] : [...extra.slice(0, at), ...args, ...extra.slice(at + 1)]
  const claude = claudeAt(path)
  return { file: claude.file, args: programArgs(claude, all) }
}

/** How to run Claude when Settings changes it. `find` is replaceable for tests. */
export function customLaunch(setting: { terminal?: string; command?: string }, args: string[], find: Find = locate): { file: string; args: string[] } {
  const command = setting.command?.trim() || 'claude'
  return setting.terminal?.trim() ? throughTerminal(setting.terminal, command, args, find) : directly(command, args, find)
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

function writeSettings(node: ClaudeNode, ctx: ClaudeLaunchContext, own: UserStatusLine | null): string {
  const script = ctx.hookScript.replace(/\\/g, '/')
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${script}" ${event}`,
              timeout: event === 'PermissionRequest' ? HELD_HOOK_TIMEOUT_S : HOOK_TIMEOUT_S
            }
          ]
        }
      ]
    ])
  )
  mkdirSync(ctx.sessionDir, { recursive: true })
  const file = join(ctx.sessionDir, `${encodeURIComponent(node.id)}.settings.json`)
  const statusLine = ctx.statusLineScript
    ? { statusLine: { type: 'command', command: `node "${ctx.statusLineScript.replace(/\\/g, '/')}"`, ...(own?.padding === undefined ? {} : { padding: own.padding }) } }
    : {}
  writeFileSync(file, JSON.stringify({ hooks, ...statusLine }, null, 2))
  return file
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
  const args = ['--settings', writeSettings(node, ctx, own), '--plugin-dir', ctx.pluginDir]
  if (ctx.permissionMode) args.push('--permission-mode', ctx.permissionMode)
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
    env: { ...sessionEnv(node.id, ctx.token, ctx), ...(own ? { PATCHBAY_STATUSLINE_FORWARD: own.command } : {}) },
    sessionId,
    resumed,
    ...(!resumed && ctx.claudeTerminal && node.prompt?.trim() ? { typedPrompt: node.prompt } : {})
  }
}
