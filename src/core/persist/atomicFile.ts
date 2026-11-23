import { readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

// Windows briefly locks files that antivirus or the search indexer has open.
const ATTEMPTS = 5
const RETRY_DELAY_MS = 125

function isLockError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EBUSY'
}

export function isMissingFile(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function withLockRetry<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action()
    } catch (e) {
      if (attempt >= ATTEMPTS || !isLockError(e)) throw e
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
}

export function withLockRetrySync<T>(action: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return action()
    } catch (e) {
      if (attempt >= ATTEMPTS || !isLockError(e)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS)
    }
  }
}

/** Returns null when the file doesn't exist. Any other read failure throws. */
export function readIfPresentSync(path: string): string | null {
  try {
    return withLockRetrySync(() => readFileSync(path, 'utf8'))
  } catch (e) {
    if (isMissingFile(e)) return null
    throw e
  }
}

/**
 * readIfPresentSync without holding up the thread. A file held briefly by antivirus made the sync one sleep for up to
 * half a second, with every request to main waiting behind it.
 */
export async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await withLockRetry(() => readFile(path, 'utf8'))
  } catch (e) {
    if (isMissingFile(e)) return null
    throw e
  }
}

/** Writes the file's bytes all the way to disk before returning. */
export async function writeSynced(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function renameWithRetry(from: string, to: string): Promise<void> {
  return withLockRetry(() => rename(from, to))
}

/** Replaces `path` so that a reader or a crash sees the whole old file or the whole new one. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.tmp`
  await writeSynced(temp, data)
  await renameWithRetry(temp, path)
}
