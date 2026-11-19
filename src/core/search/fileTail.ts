import { open, type FileHandle } from 'node:fs/promises'
import type { FileCursor } from './types'

/** Enough of the start of a file to tell a replaced transcript from one that grew. */
const HEAD_BYTES = 64
/** Read in pieces, so a transcript of tens of megabytes never sits in memory whole. */
const CHUNK_BYTES = 4 * 1024 * 1024

async function readRange(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let at = 0
  while (at < length) {
    const { bytesRead } = await handle.read(buffer, at, length - at, start + at)
    if (bytesRead === 0) break
    at += bytesRead
  }
  return buffer.subarray(0, at)
}

export interface Added {
  cursor: FileCursor
  /** The file was new, replaced or shortened, so what was read starts from its beginning. */
  fromStart: boolean
}

/**
 * Hands `onText` the complete lines added to a file since `cursor`, a piece at a time. A last line with no newline yet
 * is left for the next read, so a transcript being written is never read half-way through a line. The file is only
 * ever opened for reading. Throws if it can't be read.
 */
export async function readAdded(path: string, cursor: FileCursor | undefined, onText: (text: string) => void): Promise<Added> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const head = (await readRange(handle, 0, Math.min(HEAD_BYTES, size))).toString('latin1')
    const same = cursor && cursor.offset <= size && head.startsWith(cursor.head.slice(0, Math.min(cursor.head.length, head.length)))
    let offset = same ? cursor.offset : 0
    while (offset < size) {
      const piece = await readRange(handle, offset, Math.min(CHUNK_BYTES, size - offset))
      const end = piece.lastIndexOf(0x0a) + 1
      if (end === 0) {
        // No complete line in this piece. Only a line longer than a piece gets here: read on until its end.
        if (offset + piece.length >= size) break
        const longer = await readLongLine(handle, offset, size)
        if (longer === 0) break
        onText((await readRange(handle, offset, longer)).toString('utf8'))
        offset += longer
        continue
      }
      onText(piece.subarray(0, end).toString('utf8'))
      offset += end
    }
    return { cursor: { offset, size, head }, fromStart: !same }
  } finally {
    await handle.close()
  }
}

/** The length of the line starting at `start`, newline included, or 0 if it isn't finished yet. */
async function readLongLine(handle: FileHandle, start: number, size: number): Promise<number> {
  for (let at = start; at < size; at += CHUNK_BYTES) {
    const piece = await readRange(handle, at, Math.min(CHUNK_BYTES, size - at))
    const nl = piece.indexOf(0x0a)
    if (nl !== -1) return at - start + nl + 1
  }
  return 0
}
