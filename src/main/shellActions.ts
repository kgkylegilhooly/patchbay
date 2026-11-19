import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readTranscript } from '../core/transcript/read'
import { placeInProject } from '../core/canvas/place'
import { viewSize } from './viewSize'
import type { CanvasStore } from '../shared/contract'
import type { CanvasDoc, ClaudeNode } from '../shared/model'

export interface LinkDeps {
  exists(path: string): boolean
  openExternal(url: string): Promise<void>
  /** Resolves to an error message, or an empty string on success. */
  openPath(path: string): Promise<string>
  reveal(path: string): void
  /** For ~. Defaults to the person's home folder. */
  home?: string
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

/** A GitHub-style line anchor, as agents write in links: #L12, #L12-L20, #L12C3. */
const LINE_ANCHOR = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i

type Local = { ok: true; paths: string[] } | { ok: false; reason: string }

/**
 * The Windows paths a path written by a program may mean, most likely first. Agents and shells write the same file
 * many ways: C:\a\b.ts, C:/a/b.ts, /C:/a/b.ts and file:///C:/a/b.ts (Codex's links), /c/a/b.ts (Git Bash),
 * ~/b.ts, with a :line:col or #L12 after it, and in a link with spaces as %20.
 */
export function localPaths(cwd: string, target: string, home: string): Local {
  let t = target.trim()
  if (/^file:/i.test(t)) {
    let url: URL
    try {
      url = new URL(t)
    } catch {
      return { ok: false, reason: `That link isn't valid: ${target}` }
    }
    if (url.host && url.host.toLowerCase() !== 'localhost') return { ok: false, reason: `Network paths don't open from a terminal: ${target}` }
    t = url.pathname
  }
  t = t.replace(LINE_ANCHOR, '').replace(LOCATION_SUFFIX, '')
  if (/^[\\/]{2}/.test(t)) return { ok: false, reason: `Network paths don't open from a terminal: ${target}` }
  const forms = [t]
  if (/%[0-9a-f]{2}/i.test(t)) {
    try {
      const decoded = decodeURIComponent(t)
      if (/^[\\/]{2}/.test(decoded)) return { ok: false, reason: `Network paths don't open from a terminal: ${target}` }
      forms.push(decoded)
    } catch {
      // Not encoded after all.
    }
  }
  const paths = forms.map((f) => {
    const drive = /^[\\/]([A-Za-z])(?::?[\\/]|:?$)(.*)$/.exec(f)
    if (drive) return resolve(`${drive[1].toUpperCase()}:\\`, drive[2])
    if (f === '~' || /^~[\\/]/.test(f)) return resolve(home, f.slice(2))
    return resolve(cwd, f)
  })
  return { ok: true, paths: [...new Set(paths)] }
}

export function isRunnable(path: string): boolean {
  // Windows ignores trailing dots and spaces, and anything after a colon names a stream of the file.
  const name = basename(path).split(':')[0].replace(/[. ]+$/, '')
  const dot = name.lastIndexOf('.')
  return dot >= 0 && RUNNABLE.has(name.slice(dot + 1).toLowerCase())
}

export async function openTerminalLink(cwd: string, target: string, deps: LinkDeps): Promise<LinkResult> {
  if (SCHEME.test(target) && !/^file:/i.test(target)) {
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
  const local = localPaths(cwd, target, deps.home ?? homedir())
  if (!local.ok) return local
  const path = local.paths.find((p) => deps.exists(p))
  if (!path) return { ok: false, reason: `File not found: ${local.paths[0]}` }
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
  deps: { isDirectory(path: string): boolean | null; home?: string }
): ResolvedPath {
  if (SCHEME.test(target) && !/^file:/i.test(target)) return { ok: false, reason: `That's a link, not a path: ${target}` }
  const local = localPaths(cwd, target, deps.home ?? homedir())
  if (!local.ok) return local
  for (const path of local.paths) {
    const dir = deps.isDirectory(path)
    if (dir !== null) return { ok: true, path, folder: dir ? path : dirname(path) }
  }
  return { ok: false, reason: `File not found: ${local.paths[0]}` }
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
  // In the middle of what's on screen now (its top left when the window's size isn't known), clear of what's there.
  const { x, y } = placeInProject(doc, doc.activeProjectId, { width: 620, height: 420 }, viewSize())
  const node: ClaudeNode = {
    id: newId,
    kind: 'claude',
    ...(entry.agent ? { agent: entry.agent } : {}),
    title: entry.title,
    x,
    y,
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
