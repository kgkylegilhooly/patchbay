import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMAGE_FILE } from '../shared/whiteboard'

/** Pictures pasted onto whiteboards. A board saves only each picture's file name, so the canvas file stays small. */

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** The name a picture is saved under. Throws for one a board can't hold. */
function imageName(bytes: Uint8Array, mime: string): string {
  const ext = EXTENSIONS[mime]
  if (!ext) throw new Error(`A whiteboard can't hold this kind of picture: ${mime}`)
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('That picture is empty.')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`That picture is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`)
  return `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
}

/** Saves a picture under the name of its content, so the same one pasted twice is kept once. Returns that name. */
export function saveBoardImage(dir: string, bytes: Uint8Array, mime: string): string {
  const file = imageName(bytes, mime)
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

/**
 * What the window asks for, off the main thread. Writing, reading and encoding a 10 MB picture took 7 ms each time, on
 * the thread every other request waits on.
 */
export async function saveBoardImageAsync(dir: string, bytes: Uint8Array, mime: string): Promise<string> {
  const file = imageName(bytes, mime)
  await mkdir(dir, { recursive: true })
  const path = join(dir, file)
  const there = await access(path).then(() => true, () => false)
  // Named by its content, so a half-written file is the only way one could differ: written whole, under a temp name.
  if (!there) {
    // Its own temp name, so two saves of one picture at once can't write into each other's.
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, bytes)
    await rename(temp, path).catch(async (e: unknown) => {
      await rm(temp, { force: true })
      if (!existsSync(path)) throw e
    })
  }
  return file
}

/** Data URLs kept for pictures read lately. A name always means the same picture, so they never go stale. */
const CACHE_CHARS = 32 * 1024 * 1024
const cached = new Map<string, string>()
let cachedChars = 0

function remember(key: string, url: string): void {
  if (url.length > CACHE_CHARS / 2) return
  cached.set(key, url)
  cachedChars += url.length
  for (const [k, v] of cached) {
    if (cachedChars <= CACHE_CHARS) break
    cached.delete(k)
    cachedChars -= v.length
  }
}

/** readBoardImage, off the main thread, with the pictures read lately kept up to a limit. */
export async function readBoardImageAsync(dir: string, file: string): Promise<string | null> {
  if (typeof file !== 'string' || !IMAGE_FILE.test(file)) return null
  const key = join(dir, file)
  const hit = cached.get(key)
  if (hit !== undefined) {
    // Most recently used goes last.
    cached.delete(key)
    cached.set(key, hit)
    return hit
  }
  try {
    const url = `data:${TYPES[file.split('.')[1]]};base64,${(await readFile(key)).toString('base64')}`
    remember(key, url)
    return url
  } catch {
    return null
  }
}

/** Forgets cached pictures, for tests. */
export function clearBoardImageCache(): void {
  cached.clear()
  cachedChars = 0
}

/**
 * pruneBoardImages, off the main thread and a few files at a time, for after start-up. `used` must be taken at
 * start-up: a board deleted since then can still come back with undo, and its pictures with it.
 */
export async function pruneBoardImagesAsync(dir: string, used: Set<string>, now = Date.now()): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  const candidates = names.filter((name) => IMAGE_FILE.test(name) && !used.has(name))
  const AT_ONCE = 16
  for (let i = 0; i < candidates.length; i += AT_ONCE) {
    const counts = await Promise.all(
      candidates.slice(i, i + AT_ONCE).map(async (name) => {
        const path = join(dir, name)
        try {
          if (now - (await stat(path)).mtimeMs < UNUSED_KEPT_MS) return 0
          await rm(path, { force: true })
          return 1
        } catch {
          return 0 // A picture that can't be removed now can go next time.
        }
      })
    )
    for (const n of counts) removed += n
  }
  return removed
}
