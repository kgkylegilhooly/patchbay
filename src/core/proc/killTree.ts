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
 * P a process start later and could reach whatever had P by then. If the helper couldn't end the child itself, and its
 * exit still hasn't been seen, Node's own handle ends it. Only while the child is still known to be running; a child that
 * has exited but whose output pipes are still held (by something it started) has its pipes closed here instead, so
 * whoever waits for "close" isn't left waiting. Returns whether a kill was sent.
 */
export function killTree(child: Killable, end: (roots: KillRoot[]) => Promise<KillReport> = endTrees): boolean {
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
        if (!report?.killed.includes(pid) && !hasExited(child)) child.kill('SIGKILL')
      })
  } else {
    child.kill('SIGKILL')
  }
  return true
}
