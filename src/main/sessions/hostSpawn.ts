import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cleanEnv } from './env'

/** The host's own environment: clean like a session's, plus what it needs to run under Electron's Node. */
export function hostEnv(base: NodeJS.ProcessEnv, version: string): Record<string, string> {
  const passed: Record<string, string> = {}
  // Acceptance runs use these. cleanEnv would otherwise drop them with the other PATCHBAY_ names.
  for (const key of ['PATCHBAY_HOST_LIMITS', 'PATCHBAY_HOST_PROTOCOL']) {
    const value = base[key]
    if (value) passed[key] = value
  }
  return cleanEnv(base, { ...passed, ELECTRON_RUN_AS_NODE: '1', PATCHBAY_HOST_VERSION: version })
}

/**
 * Starts the host for a profile, using this same Electron binary as Node, so Node on PATH isn't needed and
 * node-pty loads the same way as it does in the app. It starts in the program's folder, so it can't hold open
 * a project folder or the profile, which Windows wouldn't then let anyone delete.
 */
export function spawnSessionHost(opts: { mainDir: string; dataDir: string; version: string }): void {
  const script = process.env.PATCHBAY_HOST_SCRIPT ?? join(opts.mainDir, 'sessionHost.js')
  const child = spawn(process.execPath, [join(opts.mainDir, 'hostLauncher.js'), script, opts.dataDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(process.execPath),
    env: hostEnv(process.env, opts.version)
  })
  child.on('error', (e) => console.error('Patchbay could not start its session host:', e))
  child.unref()
}

/** How long the app gets to finish exiting by itself. */
const EXIT_GUARD_MS = 4000

/**
 * Electron's teardown sometimes never finishes after a quit that leaves sessions running, for a cause not yet found.
 * test/acceptance/quitloop.cjs counts how often. Open notifications, in-flight port checks and exiting too soon have
 * each been tried and ruled out. Everything is saved by then, but the stuck process would keep the single-instance
 * lock, and the next launch would quit straight away. So a tiny separate process ends this one, by pid, if it's still
 * here after a while.
 */
export function guardExit(version: string): void {
  const script = `const pid=${process.pid};setTimeout(()=>{try{process.kill(pid)}catch{}process.exit(0)},${EXIT_GUARD_MS})`
  try {
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true, cwd: dirname(process.execPath), env: hostEnv(process.env, version) })
    child.on('error', () => {})
    child.unref()
  } catch (e) {
    console.error('Patchbay could not start its exit guard:', e)
  }
}

/** The last thing the host wrote in its log, to explain why it isn't running. */
export function lastHostLogLine(controlDir: string): string | undefined {
  try {
    const lines = readFileSync(join(controlDir, 'host.log'), 'utf8').trim().split(/\r?\n/)
    return lines[lines.length - 1] || undefined
  } catch {
    return undefined
  }
}
