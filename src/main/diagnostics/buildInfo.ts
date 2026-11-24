import type { BuildInfo } from '../../shared/diagnostics'

/**
 * Which build this is. electron.vite.config.ts asks git once when it builds and writes the answer into the main
 * process's code as `__PB_BUILD__`, for packaged and dev builds alike. A bug report then says which commit it came from,
 * rather than only "0.1.0", which every build has said so far.
 */

declare const __PB_BUILD__: BuildInfo | undefined

/** What a build made outside a git checkout, or code run without the build (as by vitest), says. */
export const UNKNOWN_BUILD: BuildInfo = { commit: 'unknown', dirty: false, branch: '', date: 'unknown' }

/** This build's, as baked in. */
export function buildInfo(): BuildInfo {
  return typeof __PB_BUILD__ !== 'undefined' && __PB_BUILD__ ? __PB_BUILD__ : UNKNOWN_BUILD
}

/** Runs git with these arguments in the source folder, giving what it printed, or null if it couldn't. */
export type Git = (args: string[]) => string | null

/** Called at build time only, by electron.vite.config.ts. */
export function readBuildInfo(git: Git, now: Date = new Date()): BuildInfo {
  const commit = git(['rev-parse', '--short=10', 'HEAD'])?.trim()
  if (!commit || !/^[0-9a-f]{4,40}$/i.test(commit)) return { ...UNKNOWN_BUILD, date: now.toISOString() }
  // Untracked files don't count: the build only reads what's tracked, and a scratch file shouldn't mark it changed.
  const status = git(['status', '--porcelain', '--untracked-files=no'])
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? ''
  return { commit, dirty: !!status?.trim(), branch, date: now.toISOString() }
}
