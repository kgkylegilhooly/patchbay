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

/**
 * Tests that write and read many real files, one after another (a hundred transcripts, say). Half a second on an idle
 * machine; past vitest's 5 s in a full run on a loaded one, where every new file waits for disk and the virus scanner
 * behind thirty other workers. These get 30 s, which still fails a read that hangs.
 */
export const REAL_FILES_TIMEOUT_MS = 30_000

/** Gives every test and hook in the calling file the real-files timeout. Call once, at the top of the file. */
export function usesRealFiles(): void {
  vi.setConfig({ testTimeout: REAL_FILES_TIMEOUT_MS, hookTimeout: REAL_FILES_TIMEOUT_MS })
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
  // rm retries each busy entry on its own, so a folder of many can take far longer than one retry run: this bounds it.
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'late'>((done) => {
    timer = setTimeout(() => done('late'), REMOVE_DEADLINE_MS)
    timer.unref?.()
  })
  try {
    const removed = rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    removed.catch(() => {})
    if ((await Promise.race([removed, deadline])) === 'late') console.warn(`Left temp folder ${dir} in place: still busy after ${REMOVE_DEADLINE_MS / 1000} s.`)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e
    console.warn(`Left temp folder ${dir} in place: ${code}.`)
  } finally {
    clearTimeout(timer)
  }
}

/** The longest a test waits for its temp folder to go. */
const REMOVE_DEADLINE_MS = 20_000
