import { execFile } from 'node:child_process'
import type { IPty } from 'node-pty'
import { endTrees, type KillReport, type KillRoot } from '../../core/proc/safeKill'
import { readConsoleMembers } from '../ports/ports'

/**
 * Ends a pty session without killing someone else's process, and without leaving its console behind.
 *
 * node-pty 1.1 ends a ConPTY session like this: it forks a helper to list the processes on the session's console, closes
 * the pseudo-console straight away, and then kills whatever the helper listed, by PID. When the shell is gone by then,
 * the helper fails ("AttachConsole failed") and node-pty, 5 s later, kills the shell's PID anyway. Round 4 listed first
 * and handed node-pty that list, which left a listed process that ended before the kill free to hand its PID on.
 *
 * Here, on Windows, safeKill's helper (docs/plans/r5-jobkill.md) proves and holds the shell but leaves it running, and
 * ends the other processes on its console and, with `tree`, everything they all started, each through a handle it has
 * proven is ours. Then node-pty closes the console with an empty list, so it kills nothing by PID: the close ends the
 * shell and anything else still on the console (started after the list, say), and the console host (conhost.exe) with
 * them. A shell that ignores the close is ended by the helper after a moment, by the same proof. One that already ended
 * (by itself, or as its children were ended) has the console's input pipe closed by the host instead (releaseConsole),
 * which is what ends its console host: node-pty can't close a console once its shell has gone.
 *
 * When the helper can't run here (blocked, missing: see safeKill's onHelperProblem), round 4's way: the console listed
 * first, the list handed to node-pty, and `taskkill /T` for a tree.
 */

/** The parts of node-pty's Windows agent this relies on (node-pty 1.1, lib/windowsPtyAgent.js). */
interface ConptyAgent {
  _useConpty?: boolean
  _useConptyDll?: boolean
  _getConsoleProcessList?: () => Promise<number[]>
  _inSocket?: { destroy(): unknown }
}

export interface EndPtyOptions {
  /** Also everything the session's processes started, as Stop on a run needs (a server's workers, say). */
  tree?: boolean
  /** When the shell was started: just before and just after pty.spawn (ms since the epoch), to prove it by. */
  born?: { after: number; before: number }
  /** How processes are ended. Defaults to safeKill's helper. */
  end?: (roots: KillRoot[]) => Promise<KillReport>
  /** The fallback's console list. Defaults to node-pty's helper. */
  list?: (pid: number) => Promise<number[]>
  /** The fallback's tree kill. Defaults to taskkill /T. */
  taskkill?: (pid: number) => Promise<void>
  /** How long a closed shell gets to end by itself. */
  graceMs?: number
}

/** The close event gives a program 5 s at most; a shell that's still there after this is ignoring it. */
const GRACE_MS = 1500
/** How long a fallback's taskkill'd tree gets to report its exit (round 4's wait). */
const TREE_EXIT_WAIT_MS = 1000

const agentOf = (proc: IPty): ConptyAgent | undefined => (proc as unknown as { _agent?: ConptyAgent })._agent
const inBoxConpty = (agent: ConptyAgent | undefined): agent is ConptyAgent => !!agent?._useConpty && !agent._useConptyDll

/**
 * Lets the console host go once the shell has ended by itself: node-pty only ever closes a console while the shell
 * runs, so without this every session that ends on its own leaves a conhost.exe behind. Only after node-pty has
 * taken the last output (its 1 s flush), since the console host's going ends that.
 */
export function releaseConsole(proc: IPty): void {
  const agent = agentOf(proc)
  if (process.platform === 'win32' && inBoxConpty(agent)) agent._inSocket?.destroy()
}

const ending = new WeakMap<IPty, Promise<boolean>>()

/**
 * Kills the session's process and everything on its console. Resolves true once node-pty has been told to end it, false
 * when it ended meanwhile (nothing left to close). Asked twice, it kills once.
 */
export function endPty(proc: IPty, stillRunning: () => boolean, opts: EndPtyOptions = {}): Promise<boolean> {
  const already = ending.get(proc)
  if (already) return already
  const done = end(proc, stillRunning, opts)
  ending.set(proc, done)
  return done
}

function taskkillTree(pid: number): Promise<void> {
  // It fails if the process has already gone, which is what was wanted anyway.
  return new Promise((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
}

/** node-pty closes the console, killing nothing itself, or exactly `list` (the fallback). */
function close(proc: IPty, list: number[] = []): void {
  const agent = agentOf(proc)
  // node-pty's own list comes after the close and falls back to the shell's bare PID: never used.
  if (inBoxConpty(agent) && typeof agent._getConsoleProcessList === 'function') agent._getConsoleProcessList = () => Promise.resolve(list)
  proc.kill()
}

async function end(proc: IPty, stillRunning: () => boolean, opts: EndPtyOptions): Promise<boolean> {
  if (process.platform !== 'win32') {
    proc.kill()
    return true
  }
  const kill = opts.end ?? endTrees
  const asked = Date.now()
  const bornBefore = opts.born ? Math.min(asked, opts.born.before) : asked
  const root: KillRoot = { pid: proc.pid, bornBefore, bornAfter: opts.born?.after }
  // The shell's parent is this process, so the helper can prove it; a winpty shell's isn't, and is left to node-pty.
  const report = await kill([{ ...root, console: true, tree: opts.tree === true, keep: true }]).catch((e: unknown): KillReport => ({ ok: false, killed: [], gone: [], kept: [], skipped: [], listed: {}, error: String(e) }))
  if (!report.ok) return fallback(proc, stillRunning, opts)
  // Ended meanwhile: the host lets its console go once its output is in (releaseConsole).
  if (!stillRunning()) return false
  close(proc)
  if (report.kept.includes(proc.pid)) {
    const later = setTimeout(() => {
      if (stillRunning()) void kill([root]).catch(() => null)
    }, opts.graceMs ?? GRACE_MS)
    later.unref?.()
  }
  return true
}

/** Round 4's way, for when the helper can't run here: by PID, listed while alive, with the gap that left. */
async function fallback(proc: IPty, stillRunning: () => boolean, opts: EndPtyOptions): Promise<boolean> {
  const members = await (opts.list ?? readConsoleMembers)(proc.pid).catch((): number[] => [])
  if (opts.tree) {
    const targets = new Set(members)
    if (stillRunning()) targets.add(proc.pid)
    await Promise.all([...targets].map((pid) => (opts.taskkill ?? taskkillTree)(pid)))
    const deadline = Date.now() + TREE_EXIT_WAIT_MS
    while (stillRunning() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  }
  // Ended meanwhile: the host lets its console go once its output is in (releaseConsole).
  if (!stillRunning()) return false
  close(proc, members)
  return true
}
