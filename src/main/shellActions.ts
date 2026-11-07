import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { readTranscript } from '../core/transcript/read'
import type { CanvasStore } from '../shared/contract'
import type { CanvasDoc, ClaudeNode } from '../shared/model'

export interface LinkDeps {
  exists(path: string): boolean
  openExternal(url: string): Promise<void>
  /** Resolves to an error message, or an empty string on success. */
  openPath(path: string): Promise<string>
  reveal(path: string): void
}

type LinkResult = { ok: true } | { ok: false; reason: string }

/** Anything Windows would run, or hand to an interpreter, when opened. Clicking only reveals these. */
const RUNNABLE = new Set(
  'exe com scr msi msp pif cpl hta jar bat cmd ps1 psm1 psd1 vbs vbe js jse wsf wsh sh bash py pyw rb pl reg lnk url scf inf application appref-ms msc gadget'
    .split(' ')
)

/**
 * Two characters or more keeps a drive letter like C: from looking like a scheme, and leaving out the
 * dot that schemes may technically have keeps a file like a.ts:3:9 from looking like one.
 */
const SCHEME = /^[a-z][a-z0-9+-]+:/i
const LOCATION_SUFFIX = /(?::\d+){1,2}$|\(\d+,\d+\)$/

function isRunnable(path: string): boolean {
  // Windows ignores trailing dots and spaces, and anything after a colon names a stream of the file.
  const name = basename(path).split(':')[0].replace(/[. ]+$/, '')
  const dot = name.lastIndexOf('.')
  return dot >= 0 && RUNNABLE.has(name.slice(dot + 1).toLowerCase())
}

export async function openTerminalLink(cwd: string, target: string, deps: LinkDeps): Promise<LinkResult> {
  if (SCHEME.test(target)) {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      return { ok: false, reason: `That link isn't valid: ${target}` }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: `Only http and https links open from a terminal: ${target}` }
    }
    try {
      await deps.openExternal(url.href)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }
  if (/^[\\/]{2}/.test(target)) {
    return { ok: false, reason: `Network paths don't open from a terminal: ${target}` }
  }
  const path = resolve(cwd, target.replace(LOCATION_SUFFIX, ''))
  if (!deps.exists(path)) return { ok: false, reason: `File not found: ${path}` }
  if (isRunnable(path)) {
    deps.reveal(path)
    return { ok: true }
  }
  const error = await deps.openPath(path)
  return error ? { ok: false, reason: error } : { ok: true }
}

export type ResolvedPath = { ok: true; path: string; folder: string } | { ok: false; reason: string }

/**
 * The full path a terminal path means, and the folder a terminal opened "here" would start in: the path itself
 * for a folder, or the folder holding a file.
 */
export function resolveTerminalPath(
  cwd: string,
  target: string,
  deps: { isDirectory(path: string): boolean | null }
): ResolvedPath {
  if (SCHEME.test(target)) return { ok: false, reason: `That's a link, not a path: ${target}` }
  if (/^[\\/]{2}/.test(target)) return { ok: false, reason: `Network paths aren't supported here: ${target}` }
  const path = resolve(cwd, target.replace(LOCATION_SUFFIX, ''))
  const dir = deps.isDirectory(path)
  if (dir === null) return { ok: false, reason: `File not found: ${path}` }
  return { ok: true, path, folder: dir ? path : dirname(path) }
}

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

/** Returns the saved file's path. Throws for a type not on the list. */
export function savePastedImage(dataDir: string, bytes: Uint8Array, mime: string): string {
  const ext = IMAGE_TYPES[mime]
  if (!ext) throw new Error(`Patchbay can't save this image type: ${mime}`)
  const dir = join(dataDir, 'pastes')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `paste-${randomUUID()}.${ext}`)
  writeFileSync(file, bytes)
  return file
}

/** Adds the conversation back as a new node. The caller starts it. Returns null if the entry is gone. */
export function reopenClosed(store: CanvasStore, closedId: string, newId: string): string | null {
  const doc = store.get()
  const entry = doc.closed.find((c) => c.id === closedId)
  if (!entry) return null
  const { x, y, zoom } = doc.viewport
  const node: ClaudeNode = {
    id: newId,
    kind: 'claude',
    ...(entry.agent ? { agent: entry.agent } : {}),
    title: entry.title,
    // Near the top left of what's on screen now.
    x: (80 - x) / zoom,
    y: (80 - y) / zoom,
    width: 620,
    height: 420,
    parentId: null,
    cwd: entry.cwd,
    sessionId: entry.sessionId,
    transcriptPath: entry.transcriptPath,
    after: []
  }
  store.dispatch({ op: 'addNode', node })
  store.dispatch({ op: 'removeClosed', id: closedId })
  return newId
}

const GONE = "This conversation's transcript no longer exists."

export function readClosedTranscript(
  doc: CanvasDoc,
  closedId: string
): { ok: true; text: string } | { ok: false; reason: string } {
  const path = doc.closed.find((c) => c.id === closedId)?.transcriptPath
  if (!path) return { ok: false, reason: GONE }
  try {
    return { ok: true, text: readTranscript(path) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: GONE }
    return { ok: false, reason: `The transcript couldn't be read: ${(e as Error).message}` }
  }
}
