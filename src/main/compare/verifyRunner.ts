import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProgram, type RunResult } from '../../core/git/run'

const VERIFY_TIMEOUT_MS = 10 * 60_000

/**
 * Runs a verification command's argument list in a folder through resources/launch-run.cjs, as a recipe's setup step
 * runs: no shell, the program found with PATHEXT, and `.cmd` scripts passed to cmd only when that's safe. `node` is
 * the program that runs the launcher: Electron's own binary as Node in the app.
 */
export function createVerifyRunner(d: { launcher: string; planDir: string; node: string; env: Record<string, string>; timeoutMs?: number }) {
  let n = 0
  return (argv: string[], cwd: string): Promise<RunResult> => {
    mkdirSync(d.planDir, { recursive: true })
    const plan = join(d.planDir, `verify-${process.pid}-${Date.now()}-${n++}.json`)
    // The launcher itself may run as Electron-as-Node; the command it starts must not inherit that.
    writeFileSync(plan, JSON.stringify({ file: argv[0], args: argv.slice(1), cwd, env: { ELECTRON_RUN_AS_NODE: null } }))
    return runProgram(d.node, [d.launcher, plan], { cwd, env: d.env, timeoutMs: d.timeoutMs ?? VERIFY_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 }).finally(() => rmSync(plan, { force: true }))
  }
}
