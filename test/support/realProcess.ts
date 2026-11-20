import { rm } from 'node:fs/promises'
import { vi } from 'vitest'

/**
 * Tests that start real git, node, bash or console processes. Each takes one to six seconds on an idle machine, and
 * several times that when the full suite runs alongside other work, as every vitest worker starts processes at once.
 * Vitest's 5 s default is for in-process tests; these get a minute, which still fails a hung process in good time.
 */
export const REAL_PROCESS_TIMEOUT_MS = 60_000

/** Gives every test and hook in the calling file the real-process timeout. Call once, at the top of the file. */
export function usesRealProcesses(): void {
  vi.setConfig({ testTimeout: REAL_PROCESS_TIMEOUT_MS, hookTimeout: REAL_PROCESS_TIMEOUT_MS })
}

/** The least time a test's git runs get. Patchbay's own limits (5 to 20 s) are for a hung git, not a busy machine. */
export const PATIENT_GIT_MS = 45_000

/** A git runner whose limits are at least {@link PATIENT_GIT_MS}, so a slow start isn't read as git hanging. */
export function patientGit<R, Rest extends unknown[]>(
  run: (cwd: string, args: string[], limit: { timeoutMs: number; maxBytes: number }, ...rest: Rest) => R
): (cwd: string, args: string[], limit: { timeoutMs: number; maxBytes: number }, ...rest: Rest) => R {
  return (cwd, args, limit, ...rest) => run(cwd, args, { ...limit, timeoutMs: Math.max(limit.timeoutMs, PATIENT_GIT_MS) }, ...rest)
}

/**
 * Removes a test's own temp folder. On Windows a folder can't go while a process that was started in it is still
 * exiting (EBUSY), which takes longer on a busy machine: this retries for up to about 20 s. A folder still held after
 * that is left in the system temp folder rather than failing a test whose assertions all passed.
 */
export async function removeTemp(dir: string | undefined): Promise<void> {
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e
    console.warn(`Left temp folder ${dir} in place: ${code}.`)
  }
}
