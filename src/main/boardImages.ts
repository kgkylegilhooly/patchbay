import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IMAGE_FILE } from '../shared/whiteboard'

/** Pictures pasted onto whiteboards. A board saves only each picture's file name, so the canvas file stays small. */

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Saves a picture under the name of its content, so the same one pasted twice is kept once. Returns that name. */
export function saveBoardImage(dir: string, bytes: Uint8Array, mime: string): string {
  const ext = EXTENSIONS[mime]
  if (!ext) throw new Error(`A whiteboard can't hold this kind of picture: ${mime}`)
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('That picture is empty.')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`That picture is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
  const file = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  if (!existsSync(path)) writeFileSync(path, bytes)
  return file
}

/** Old enough that no board coming back from a recent backup could still want it. */
const UNUSED_KEPT_MS = 24 * 60 * 60_000

/**
 * Deletes pictures no board uses, as at startup, when there's no undo history that could bring a board back. Only
 * files this saves are touched, and only once they're a day old. Returns how many went.
 */
export function pruneBoardImages(dir: string, used: Set<string>, now = Date.now()): number {
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!IMAGE_FILE.test(name) || used.has(name)) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs < UNUSED_KEPT_MS) continue
      rmSync(path, { force: true })
      removed++
    } catch {
      // A picture that can't be removed now can go next time.
    }
  }
  return removed
}

/** A saved picture as a data URL, or null if the name isn't one this saves or the file has gone. */
export function readBoardImage(dir: string, file: string): string | null {
  if (typeof file !== 'string' || !IMAGE_FILE.test(file)) return null
  try {
    return `data:${TYPES[file.split('.')[1]]};base64,${readFileSync(join(dir, file)).toString('base64')}`
  } catch {
    return null
  }
}
