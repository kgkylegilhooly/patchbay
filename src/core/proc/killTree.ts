import { spawn } from 'node:child_process'
import { endTrees, type KillReport, type KillRoot } from './safeKill'

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
 * Ends a child and everything it started. Windows ends a process without its children, so on Windows safeKill's helper
 * ends the tree, through handles it has proven are ours (docs/plans/r5-jobkill.md), where `taskkill /pid P /T /F` opened
 * P a process start later and could reach whatever had P by then. If the helper can't run here (blocked, missing), round
 * 4's taskkill /T, while the exit is still unseen. If it ran but couldn't end the child (too new to prove), Node's own
 * handle ends the child alone. Only while the child is still known to be running; a child that
 * has exited but whose output pipes are still held (by something it started) has its pipes closed here instead, so
 * whoever waits for "close" isn't left waiting. Returns whether a kill was sent.
 */
export function killTree(child: Killable, end: (roots: KillRoot[]) => Promise<KillReport> = endTrees, start: typeof spawn = spawn): boolean {
  if (hasExited(child)) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    return false
  }
  if (process.platform === 'win32' && child.pid) {
    const pid = child.pid
    void end([{ pid, bornBefore: Date.now(), tree: true }])
      .catch(() => null)
      .then((report) => {
        if (hasExited(child) || report?.killed.includes(pid)) return
        if (report?.ok) return void child.kill('SIGKILL')
        try {
          start('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'))
        } catch {
          child.kill('SIGKILL')
        }
      })
  } else {
    child.kill('SIGKILL')
  }
  return true
}
