import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from '../core/persist/atomicFile'
import { describePlan, readLaunchItems } from '../core/launch/launchJson'
import type { LaunchListing } from '../shared/contract'


/** Reads a folder's .vscode/launch.json and says what each entry would run. It never runs anything. */
export function listLaunchConfigs(folder: string): LaunchListing | { ok: false; reason: string } {
  const file = join(folder, '.vscode', 'launch.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `There's no .vscode\\launch.json in ${folder}.` : `Couldn't read ${file}: ${(e as Error).message}` }
  }
  const read = readLaunchItems(text, { folder, env: process.env, home: homedir() })
  if (!read.ok) return read
  return {
    ok: true,
    file,
    // `approve`: the plan as shown, so picking it in the form is agreeing to it (LJ1).
    items: read.items.map((item) => (item.kind === 'config' && item.plan ? { ...item, command: describePlan(item.plan), cwd: item.plan.cwd, approve: planKey(item.plan) } : item))
  }
}

/** Forward slashes and double quotes read the same in Git Bash, PowerShell and cmd. */
const quoted = (path: string): string => `"${path.replace(/\\/g, '/')}"`

/** What a plan is agreed to by: the program, arguments, folder and environment it runs with, all of them. */
export const planKey = (plan: unknown): string => createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 32)

/**
 * Reads launch.json again, as a click on Run asks, and writes the plan the launcher runs. A configuration that has
 * gone, or can no longer be run as written, is refused with the reason rather than run from an older copy.
 *
 * LJ1: launch.json is a file in the repository, which an agent can rewrite with file access alone. So a plan runs only
 * once the person has agreed to exactly it: `approved` is the one agreed before, and `accept` the one agreed now, from
 * the question this asks. Anything else, a first run or a changed file, is refused with the command it would run.
 * Restart when it stops never passes `accept`, so an edit can't start by itself.
 */
export async function prepareLaunchRun(
  launch: { folder: string; name: string; approved?: string },
  ctx: { planFile: string; launcher: string },
  accept?: string
): Promise<{ ok: true; command: string; cwd: string; approved: string } | { ok: false; reason: string; approvePlan?: string }> {
  const listing = listLaunchConfigs(launch.folder)
  if (!listing.ok) return listing
  const item = listing.items.find((i) => i.kind === 'config' && i.name === launch.name)
  if (!item || item.kind !== 'config') return { ok: false, reason: `launch.json no longer has a configuration called "${launch.name}".` }
  if (!item.plan) return { ok: false, reason: `"${launch.name}" can't run here: ${item.problem}` }
  const key = planKey(item.plan)
  if (key !== launch.approved && key !== accept) {
    const what = launch.approved ? 'launch.json has changed since this was last run' : "This hasn't been run from here before"
    const env = Object.entries(item.plan.env).map(([k, v]) => (v === null ? `without ${k}` : `${k}=${v}`))
    const extra = env.length ? `, with ${env.join(', ')}` : ''
    return { ok: false, reason: `${what}. "${launch.name}" would run: ${describePlan(item.plan)} (in ${item.plan.cwd}${extra}). Run it only if you expect that.`, approvePlan: key }
  }
  mkdirSync(join(ctx.planFile, '..'), { recursive: true })
  await writeAtomic(ctx.planFile, JSON.stringify(item.plan))
  return { ok: true, command: `node ${quoted(ctx.launcher)} ${quoted(ctx.planFile)}`, cwd: launch.folder, approved: key }
}
