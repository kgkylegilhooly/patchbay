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
    items: read.items.map((item) => (item.kind === 'config' && item.plan ? { ...item, command: describePlan(item.plan), cwd: item.plan.cwd } : item))
  }
}

/** Forward slashes and double quotes read the same in Git Bash, PowerShell and cmd. */
const quoted = (path: string): string => `"${path.replace(/\\/g, '/')}"`

/**
 * Reads launch.json again, as a click on Run asks, and writes the plan the launcher runs. A configuration that has
 * gone, or can no longer be run as written, is refused with the reason rather than run from an older copy.
 */
export async function prepareLaunchRun(
  launch: { folder: string; name: string },
  ctx: { planFile: string; launcher: string }
): Promise<{ ok: true; command: string; cwd: string } | { ok: false; reason: string }> {
  const listing = listLaunchConfigs(launch.folder)
  if (!listing.ok) return listing
  const item = listing.items.find((i) => i.kind === 'config' && i.name === launch.name)
  if (!item || item.kind !== 'config') return { ok: false, reason: `launch.json no longer has a configuration called "${launch.name}".` }
  if (!item.plan) return { ok: false, reason: `"${launch.name}" can't run here: ${item.problem}` }
  mkdirSync(join(ctx.planFile, '..'), { recursive: true })
  await writeAtomic(ctx.planFile, JSON.stringify(item.plan))
  return { ok: true, command: `node ${quoted(ctx.launcher)} ${quoted(ctx.planFile)}`, cwd: launch.folder }
}
