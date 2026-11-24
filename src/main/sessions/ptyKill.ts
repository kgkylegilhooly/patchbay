import type { IPty } from 'node-pty'
import { endTrees, type KillReport, type KillRoot } from '../../core/proc/safeKill'

/**
 * Ends a pty session without killing someone else's process.
 *
 * node-pty 1.1 ends a ConPTY session like this: it forks a helper to list the processes on the session's console, closes
 * the pseudo-console straight away, and then kills whatever the helper listed, by PID. When the shell is gone by then,
 * the helper fails ("AttachConsole failed") and node-pty, 5 s later, kills the shell's PID anyway. Round 4 listed first
 * and handed node-pty that list, which left a listed process that ended before the kill free to hand its PID on.
 *
 * Here nothing is killed by PID. On Windows the shell, its console's processes and, with `tree`, everything they started
 * are ended by safeKill's helper, which holds each one's handle and proves it ours first (docs/plans/r5-jobkill.md),
 * while the console is still open. Then node-pty closes the console with an empty list, so it kills nothing itself.
 * A helper that can't run kills nothing; closing the console still ends what's on it, as closing a console window does.
 */

/** The parts of node-pty's Windows agent this relies on (node-pty 1.1, lib/windowsPtyAgent.js). */
interface ConptyAgent {
  _useConpty?: boolean
  _useConptyDll?: boolean
  _getConsoleProcessList?: () => Promise<number[]>
}

export interface EndPtyOptions {
  /** Also everything the session's processes started, as Stop on a run needs (a server's workers, say). */
  tree?: boolean
  /** How processes are ended. Defaults to safeKill's helper. */
  end?: (roots: KillRoot[]) => Promise<KillReport>
}

const ending = new WeakMap<IPty, Promise<boolean>>()

/**
 * Kills the session's process and everything on its console. Resolves true once node-pty has been told to end it, false
 * when it ended meanwhile (by itself, or by the helper: either way nothing is left to close). Asked twice, it kills once.
 */
export function endPty(proc: IPty, stillRunning: () => boolean, opts: EndPtyOptions = {}): Promise<boolean> {
  const already = ending.get(proc)
  if (already) return already
  const done = end(proc, stillRunning, opts)
  ending.set(proc, done)
  return done
}

async function end(proc: IPty, stillRunning: () => boolean, opts: EndPtyOptions): Promise<boolean> {
  if (process.platform !== 'win32') {
    proc.kill()
    return true
  }
  const kill = opts.end ?? endTrees
  // The shell's parent is this process, so the helper can prove it; a winpty shell's isn't, and is left to node-pty.
  await kill([{ pid: proc.pid, bornBefore: Date.now(), console: true, tree: opts.tree === true }]).catch(() => null)
  if (!stillRunning()) return false
  const agent = (proc as unknown as { _agent?: ConptyAgent })._agent
  // node-pty's own list comes after the close and falls back to the shell's bare PID: never used.
  if (agent?._useConpty && !agent._useConptyDll && typeof agent._getConsoleProcessList === 'function') agent._getConsoleProcessList = () => Promise.resolve([])
  proc.kill()
  return true
}
