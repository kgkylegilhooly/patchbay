import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readIfPresentSync, writeAtomic } from './atomicFile'

export const DEFAULT_SCROLLBACK_CAP_BYTES = 1048576

export interface ScrollbackStore {
  read(id: string): string | null
  write(id: string, data: string): Promise<void>
  remove(id: string): Promise<void>
}

/** Percent-encodes anything outside a safe set, so distinct ids always get distinct, contained names. */
function fileNameFor(id: string): string {
  let name = ''
  for (const byte of Buffer.from(id, 'utf8')) {
    const char = String.fromCharCode(byte)
    name += /[A-Za-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return `${name}.log`
}

function keepTail(data: string, capBytes: number): Buffer {
  const bytes = Buffer.from(data, 'utf8')
  if (bytes.length <= capBytes) return bytes
  let start = bytes.length - capBytes
  // 0b10xxxxxx marks the inside of a UTF-8 character.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start)
}

/** Stores each node's scrollback at `<dir>/scrollback/<id>.log`. */
export function createScrollbackStore(dir: string, capBytes = DEFAULT_SCROLLBACK_CAP_BYTES): ScrollbackStore {
  const pathFor = (id: string) => join(dir, 'scrollback', fileNameFor(id))
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue(action: () => Promise<void>): Promise<void> {
    const run = queue.then(action)
    queue = run.catch(() => {})
    return run
  }

  return {
    read: (id) => readIfPresentSync(pathFor(id)),
    write: (id, data) => enqueue(() => writeAtomic(pathFor(id), keepTail(data, capBytes))),
    remove: (id) => enqueue(() => rm(pathFor(id), { force: true, maxRetries: 5, retryDelay: 100 }))
  }
}
