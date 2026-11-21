import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { customLaunch, programArgs, type ClaudeProgram } from './claudeLaunch'

/**
 * Which Node runs Patchbay's hooks, when Claude Code can start it itself.
 *
 * A hook written as a command line goes through a shell: Git Bash on Windows, or PowerShell without it, which then
 * starts Node. On a PC short of memory or CPU each of those can take a second or more to start, and together they ran
 * past the hook's limit, so Claude showed the person a red "timed out" line and the event was lost. Claude Code 2.1.139
 * and later can start a program directly ("exec form": `command` plus `args`), so only Node starts. See
 * docs/plans/hook-cost.md for the numbers.
 *
 * Node is found once per app run by asking whichever `node` the PATH gives where its program really is, so a version
 * manager's shim (Volta's, scoop's) isn't started in front of it for every event.
 */

/** The first Claude Code that starts a hook's program directly when the hook has `args`. */
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
 * Whether this Claude starts a hook's program directly. A Claude too old for it would run the bare path to Node as a
 * shell command, which fails on every event, so anything unclear keeps the command line.
 *
 * Inside another terminal program Claude may not be running on Windows at all (WSL), so that keeps it too.
 */
export function claudeRunsExecHooks(launch: HookLaunch, ask: Ask = output): Promise<boolean> {
  if (launch.claudeTerminal?.trim()) return Promise.resolve(false)
  let program: { file: string; args: string[] }
  try {
    program = launch.claudeCommand?.trim()
      ? customLaunch({ command: launch.claudeCommand }, ['--version'])
      : launch.claude
        ? { file: launch.claude.file, args: programArgs(launch.claude, ['--version']) }
        : (() => {
            throw new Error('no program')
          })()
  } catch {
    return Promise.resolve(false)
  }
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

/** The node.exe a PATH lookup of `node` ends up running, or null when there's none. */
export async function hookNode(ask: Ask = output): Promise<string | null> {
  if (!nodeKnown) {
    nodeKnown = ask('node', ['-p', 'process.execPath']).then(
      (text) => text.trim().split(/\r?\n/).pop()?.trim() || null,
      () => null
    )
  }
  const path = await nodeKnown
  // On Windows only a .exe can be started without a shell.
  const startable = !!path && (process.platform !== 'win32' || /\.exe$/i.test(path))
  if (path && startable && existsSync(path)) return path
  // A Node installed later, or one that moved, is looked for again at the next launch.
  nodeKnown = null
  return null
}

/**
 * The Node for a Claude launch's hooks to start directly, or null to keep them as command lines. Never rejects, and
 * costs nothing after a program's first launch in an app run.
 */
export async function hookNodeFor(launch: HookLaunch, ask: Ask = output): Promise<string | null> {
  if (!(await claudeRunsExecHooks(launch, ask))) return null
  return hookNode(ask)
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
