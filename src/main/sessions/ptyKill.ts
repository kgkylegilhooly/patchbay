import type { IPty } from 'node-pty'
import { readConsoleMembers } from '../ports/ports'

/**
 * Ends a pty session without killing someone else's process.
 *
 * node-pty 1.1 ends a ConPTY session like this: it forks a helper to list the processes on the session's console, closes
 * the pseudo-console straight away, and then kills whatever the helper listed. The helper finds the console by the
 * shell's PID, after the close. When the shell is gone by then, the helper fails ("AttachConsole failed") and node-pty,
 * 5 s later, kills the shell's PID anyway. Windows hands PIDs out again quickly, so that kill can end any process on the
 * PC: in a busy test run it ended vitest workers ("Worker exited unexpectedly with exit code 1"). And a PID taken by a
 * process on another console would have the helper list, and kill, that console.
 *
 * Here the list is taken first, while the shell still holds its console, so it's right and its PIDs are live; node-pty is
 * handed that list, and kills exactly those once it has closed the console. A list that fails or is slow kills nothing
 * more than the close itself does. See docs/plans/r4-leftovers.md.
 */

/** The parts of node-pty's Windows agent this relies on (node-pty 1.1, lib/windowsPtyAgent.js). */
interface ConptyAgent {
  _useConpty?: boolean
  _useConptyDll?: boolean
  _innerPid?: number
  _getConsoleProcessList?: () => Promise<number[]>
}

const ending = new WeakMap<IPty, Promise<boolean>>()

/**
 * Kills the session's process and everything on its console. Resolves true once node-pty has been told to end it, false
 * when it ended by itself while the list was taken (nothing left to kill). Asked twice, it kills once.
 */
export function endPty(proc: IPty, stillRunning: () => boolean, list: (pid: number) => Promise<number[]> = readConsoleMembers): Promise<boolean> {
  const already = ending.get(proc)
  if (already) return already
  const done = end(proc, stillRunning, list)
  ending.set(proc, done)
  return done
}

async function end(proc: IPty, stillRunning: () => boolean, list: (pid: number) => Promise<number[]>): Promise<boolean> {
  const agent = (proc as unknown as { _agent?: ConptyAgent })._agent
  const listsAfterClose = process.platform === 'win32' && !!agent?._useConpty && !agent._useConptyDll && typeof agent._getConsoleProcessList === 'function' && !!agent._innerPid
  if (!listsAfterClose) {
    // winpty lists before it closes, and conpty.dll lists nothing: node-pty's own kill is safe there.
    proc.kill()
    return true
  }
  const members = await list(agent._innerPid!).catch((): number[] => [])
  if (!stillRunning()) return false
  agent._getConsoleProcessList = () => Promise.resolve(members)
  proc.kill()
  return true
}
