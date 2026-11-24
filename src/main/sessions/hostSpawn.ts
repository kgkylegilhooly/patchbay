import { spawn } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

/**
 * Inside Electron, fs treats app.asar as a folder, so copying the program would copy what's inside the archive rather
 * than the archive. Electron's original-fs is fs without that. Elsewhere, as in tests, it's plain fs.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs: typeof nodeFs = process.versions.electron ? require('original-fs') : nodeFs
const { cp, open, readdir, rename, rm, stat, writeFile } = realFs.promises
const existsSync = (path: string): boolean => realFs.existsSync(path)
import { cleanEnv } from './env'
import { endParentCommand } from '../../core/proc/safeKill'

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

/** The host's copy of the program is named so, apart from the app's, in Task Manager and to an installer. */
export const HOST_EXE = 'Patchbay Host.exe'
/** Top-level files a host doesn't need, all for drawing a window: graphics, translations, page resources. */
const NOT_FOR_HOST = /^(locales|Uninstall .*\.exe|LICENSE.*|dxcompiler\.dll|d3dcompiler_47\.dll|vk_swiftshader.*|vulkan-1\.dll|resources\.pak|chrome_\d+_percent\.pak)$/i
/** Written last, so a copy cut short is never used. */
const COMPLETE = '.complete'

/** Names a build by its program and its app files, since one version number can cover many builds. */
async function buildKey(installDir: string, version: string): Promise<string> {
  const [exe, asar] = await Promise.all([stat(join(installDir, 'Patchbay.exe')), stat(join(installDir, 'resources', 'app.asar'))])
  return `${version}-${Math.round(asar.mtimeMs).toString(36)}-${asar.size.toString(36)}-${exe.size.toString(36)}`
}

/**
 * A copy of the installed program for the session host to run from, outside the install folder. Running from the
 * install folder, the host kept the program's files open, so a new version couldn't be installed without stopping
 * every session, including agents working on Patchbay itself. From its own copy it carries on through an install, and
 * the new version reconnects to it. Made once per build, in the background, and skipped by a build run from source.
 * Returns null if it can't be made; the host then runs from the install folder, as it used to.
 */
export async function hostRuntime(opts: { installDir: string; baseDir: string; version: string; mainDir: string }): Promise<{ exe: string; mainDir: string } | null> {
  try {
    const dir = join(opts.baseDir, await buildKey(opts.installDir, opts.version))
    const found = { exe: join(dir, HOST_EXE), mainDir: join(dir, relative(opts.installDir, opts.mainDir)) }
    if (existsSync(join(dir, COMPLETE))) return found
    const partial = `${dir}.partial-${process.pid}`
    await rm(partial, { recursive: true, force: true })
    await cp(opts.installDir, partial, {
      recursive: true,
      filter: (src) => {
        const rel = relative(opts.installDir, src)
        return rel === '' || rel.includes(sep) || !NOT_FOR_HOST.test(rel)
      }
    })
    await rename(join(partial, 'Patchbay.exe'), join(partial, HOST_EXE))
    await writeFile(join(partial, COMPLETE), '')
    await rename(partial, dir).catch(async (e: unknown) => {
      // Another launch made the same copy first, which is just as good.
      await rm(partial, { recursive: true, force: true })
      if (!existsSync(join(dir, COMPLETE))) throw e
    })
    return found
  } catch (e) {
    console.error('Patchbay could not make a copy of itself for its session host:', e)
    return null
  }
}

/**
 * Removes copies no host is running from. A copy whose program is running can't be opened for writing, and is left.
 * Only whole copies are removed, so a host still running is never left with half of one.
 */
export async function pruneHostRuntimes(baseDir: string, keep: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(baseDir)
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(baseDir, name)
    if (dir === keep || name.includes('.partial-')) continue
    try {
      const handle = await open(join(dir, HOST_EXE), 'r+')
      await handle.close()
    } catch (e) {
      // Running, so it stays. A copy that never finished has no program, and goes.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Starts the host for a profile, using an Electron binary as Node, so Node on PATH isn't needed and node-pty loads the
 * same way as it does in the app: the host's own copy when there is one, else this one. It starts in that program's
 * folder, so it can't hold open a project folder or the profile, which Windows wouldn't then let anyone delete.
 */
export function spawnSessionHost(opts: { mainDir: string; dataDir: string; version: string; exe?: string }): void {
  const exe = opts.exe ?? process.execPath
  const script = process.env.PATCHBAY_HOST_SCRIPT ?? join(opts.mainDir, 'sessionHost.js')
  const child = spawn(exe, [join(opts.mainDir, 'hostLauncher.js'), script, opts.dataDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(exe),
    env: hostEnv(process.env, opts.version)
  })
  child.on('error', (e) => console.error('Patchbay could not start its session host:', e))
  child.unref()
}

/** The exit guard's script and what it needs in its environment, to end `pid` (its parent) after `ms`. Exported for tests. */
export function exitGuard(pid: number, ms: number, platform: NodeJS.Platform = process.platform): { script: string; env: Record<string, string> } {
  if (platform !== 'win32') return { script: `const pid=${pid};setTimeout(()=>{try{process.kill(pid)}catch{}process.exit(0)},${ms})`, env: {} }
  const script =
    `const k=JSON.parse(process.env.PB_EXIT_GUARD);setTimeout(()=>{try{` +
    `const c=require('child_process').spawn(k.file,k.args,{env:k.env,stdio:'ignore',windowsHide:true});` +
    `c.on('exit',()=>process.exit(0));c.on('error',()=>process.exit(0))}catch{process.exit(0)}},${ms})`
  return { script, env: { PB_EXIT_GUARD: JSON.stringify(endParentCommand(pid)) } }
}

/** How long the app gets to finish exiting by itself. */
const EXIT_GUARD_MS = 4000

/**
 * Electron's teardown sometimes never finishes after a quit that leaves sessions running, for a cause not yet found.
 * test/acceptance/quitloop.cjs counts how often. Open notifications, in-flight port checks and exiting too soon have
 * each been tried and ruled out. Everything is saved by then, but the stuck process would keep the single-instance
 * lock, and the next launch would quit straight away. So a tiny separate process ends this one if it's still here after
 * a while. Not by its PID alone: after a normal quit that PID may be another process's 4 s later. On Windows the guard
 * has safeKill's helper end its parent only if the process with that PID was created before the guard, so is the app
 * (docs/plans/r5-jobkill.md).
 */
export function guardExit(version: string): void {
  const { script, env } = exitGuard(process.pid, EXIT_GUARD_MS)
  try {
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true, cwd: dirname(process.execPath), env: { ...hostEnv(process.env, version), ...env } })
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
