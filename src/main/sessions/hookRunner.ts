import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { programArgs, type ClaudeProgram } from './claudeLaunch'

/**
 * Which Node runs Patchbay's hooks, when Claude Code can start it itself.
 *
 * A hook written as a command line goes through a shell: Git Bash on Windows, or PowerShell without it, which then
 * starts Node. On a PC short of memory or CPU each of those can take a second or more to start, and together they ran
 * past the hook's limit, so Claude showed the person a red "timed out" line and the event was lost. Claude Code 2.1.139
 * and later can start a program directly ("exec form": `command` plus `args`), so only Node starts. See
 * docs/plans/hook-cost.md for the numbers.
 *
 * The path written into a session's settings stays there for the session's life, which can be days. So it's the
 * `node.exe` the PATH gives, the very program the command line would have run: a version manager's shim (Volta's,
 * scoop's) is kept, since it follows the person's choice of version and outlives uninstalling one. Only a folder made for
 * one shell and removed later (fnm's) is looked through, to the installed Node behind it. Anything else, such as a
 * PATH whose first `node` is a .cmd, keeps the command line.
 */

/**
 * The first Claude Code that starts a hook's program directly when the hook has `args`. Its changelog, under 2.1.139:
 * "Added hook `args: string[]` field (exec form) that spawns the command directly without a shell". Older ones ignore
 * `args` and would run the bare path to Node as a command line, which fails on every event.
 */
export const EXEC_HOOKS_SINCE: readonly [number, number, number] = [2, 1, 139]

/** "2.1.330 (Claude Code)" as [2, 1, 330], or null for anything else. */
export function parseClaudeVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function runsExecHooks(version: readonly number[] | null): boolean {
  if (!version) return false
  for (let i = 0; i < 3; i++) if (version[i] !== EXEC_HOOKS_SINCE[i]) return version[i] > EXEC_HOOKS_SINCE[i]
  return true
}

export type Ask = (file: string, args: string[]) => Promise<string>

/** What a launch runs Claude with, as nodeRunner has it. */
export interface HookLaunch {
  claude?: ClaudeProgram
  claudeCommand?: string
  claudeTerminal?: string
}

/** One answer per program and app run, shared by nodes that start together, as when a canvas reopens. */
const execKnown = new Map<string, Promise<boolean>>()
let nodeKnown: Promise<string | null> | null = null

/**
 * Whether this Claude starts a hook's program directly. Only the `claude` program Patchbay found itself is asked.
 *
 * A custom Claude command from Settings is never run just to ask: it can be a wrapper that does more than print a
 * version, `npx` that downloads, or Claude on another machine or in WSL, where a Windows path to Node means nothing. So
 * that, and Claude inside another terminal program, keep the command line, as anything unclear does.
 */
export function claudeRunsExecHooks(launch: HookLaunch, ask: Ask = output): Promise<boolean> {
  if (launch.claudeTerminal?.trim() || launch.claudeCommand?.trim() || !launch.claude) return Promise.resolve(false)
  const program = { file: launch.claude.file, args: programArgs(launch.claude, ['--version']) }
  const key = [program.file, ...program.args].join('\0')
  let known = execKnown.get(key)
  if (!known) {
    known = ask(program.file, program.args).then(
      (text) => runsExecHooks(parseClaudeVersion(text)),
      () => false
    )
    execKnown.set(key, known)
  }
  return known
}

/** Folders a version manager makes for one shell and removes later: fnm's, one per shell it set up. */
const ONE_SHELL_FOLDER = /[\\/]fnm_multishells[\\/]/i

const isExe = (path: string | undefined): path is string => !!path && /\.exe$/i.test(path) && existsSync(path)

async function findNode(ask: Ask): Promise<string | null> {
  // Only on Windows, where hooks went through Git Bash or PowerShell. Elsewhere `sh -c` costs next to nothing.
  if (process.platform !== 'win32') return null
  const first = (await ask('where.exe', ['node'])).split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  if (!isExe(first)) return null
  if (!ONE_SHELL_FOLDER.test(first)) return first
  const real = (await ask(first, ['-p', 'process.execPath'])).trim().split(/\r?\n/).pop()?.trim()
  return isExe(real) && !ONE_SHELL_FOLDER.test(real) ? real : null
}

/** The node.exe for hooks to start directly, or null to keep the command line. */
export async function hookNode(ask: Ask = output): Promise<string | null> {
  const known = nodeKnown ? await nodeKnown : null
  if (known && existsSync(known)) return known
  // Not found yet, or found and gone since, as after an upgrade moved it: looked for again. No answer is kept, so a Node
  // installed later is found at the next launch.
  const found = (nodeKnown = findNode(ask).catch(() => null))
  const path = await found
  if (!path && nodeKnown === found) nodeKnown = null
  return path
}

/**
 * The Node for a Claude launch's hooks to start directly, or null to keep them as command lines. Never rejects, and
 * costs nothing after a program's first launch in an app run. Both questions are asked at once.
 */
export async function hookNodeFor(launch: HookLaunch, ask: Ask = output): Promise<string | null> {
  const [exec, node] = await Promise.all([claudeRunsExecHooks(launch, ask), hookNode(ask)])
  return exec ? node : null
}

/** For tests. */
export function forgetHookRunners(): void {
  execKnown.clear()
  nodeKnown = null
}

function output(file: string, args: string[]): Promise<string> {
  // programArgs builds cmd.exe's line as node-pty passes it: as written. Node would quote it again.
  const verbatim = /^cmd(.exe)?$/i.test(basename(file))
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, windowsVerbatimArguments: verbatim }, (error, stdout) => {
      if (error && !stdout) reject(error)
      else resolve(stdout)
    })
  })
}
