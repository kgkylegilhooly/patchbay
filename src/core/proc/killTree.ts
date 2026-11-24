import { spawn } from 'node:child_process'

/** What this needs of a ChildProcess. */
export interface Killable {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | string | null
  kill(signal?: NodeJS.Signals): boolean
  stdout?: { destroy(): unknown } | null
  stderr?: { destroy(): unknown } | null
}

/**
 * Whether the child's exit has been seen. Until then Node holds a handle to the process, so Windows can't give its PID
 * to another process; after it, it can, and quickly.
 */
export const hasExited = (child: Killable): boolean => child.exitCode !== null || child.signalCode !== null

/**
 * Ends a child and everything it started. Windows ends a process without its children, hence taskkill /T. Only while
 * the child is still known to be running: `taskkill /pid P /T /F` after it exited ends whatever process has P now, and
 * its tree (in a busy test run that was a vitest worker). A child that has exited but whose output pipes are still held
 * (by something it started) has its pipes closed here instead, so whoever waits for "close" isn't left waiting.
 * Returns whether a kill was sent.
 */
export function killTree(child: Killable, start: typeof spawn = spawn): boolean {
  if (hasExited(child)) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    return false
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = start('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => child.kill('SIGKILL'))
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    child.kill('SIGKILL')
  }
  return true
}
