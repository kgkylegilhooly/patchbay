import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import type { Stats } from 'node:fs'
import type { CanvasStore } from '../../shared/contract'
import type { CanvasDoc, ReaderNode } from '../../shared/model'
import type { ImageResult } from '../../shared/reader'
import { linksStayLocal, type LinkFs } from './links'
import { insideFolder, systemFolders } from './policy'
import { agentFolders } from './verbs'

/**
 * Pictures a document shows. The window's CSP loads images only from itself and data: URLs, and stays that way: main
 * reads a local picture, checks it, and hands it over as a data: URL. Remote pictures are never fetched.
 */

/** The largest picture shown. A screenshot is well under this; base64 makes the URL a third larger again. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.ico', '.svg']

type Fail = { ok: false; reason: string }

/** What the bytes are, from their first bytes, not the name. Null for anything that isn't a picture this shows. */
export function sniffImage(bytes: Uint8Array, ext: string): string | null {
  const starts = (...b: number[]): boolean => b.every((v, i) => bytes[i] === v)
  const ascii = (at: number, s: string): boolean => [...s].every((c, i) => bytes[at + i] === c.charCodeAt(0))
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(0, 'BM')) return 'image/bmp'
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif'
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon'
  // SVG is text, so it has no magic bytes: it must be named .svg and start, after any prolog, with an <svg> element.
  // An SVG in an <img> runs no script and loads nothing, so this is enough.
  if (ext === '.svg') {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096))
    const rest = head.replace(/^\s*(<\?xml[^>]*\?>\s*)?((<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*/i, '')
    if (/^<svg[\s>]/i.test(rest)) return 'image/svg+xml'
  }
  return null
}

const extOf = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * Where a picture in a document is: relative to the document's folder, a full drive path, or a file: URL. Anything
 * with another scheme (http, https, data and the rest) is remote here and isn't loaded.
 */
export function imagePath(docPath: string, href: string): { ok: true; path: string; bare?: string } | (Fail & { remote?: boolean }) {
  let t = (typeof href === 'string' ? href : '').trim()
  if (!t) return { ok: false, reason: 'The picture has no address.' }
  const drive = /^[a-z]:[\\/]/i.test(t)
  if (!drive && /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^file:/i.test(t)) return { ok: false, remote: true, reason: 'Pictures from the web are not loaded in the Reader.' }
  if (/^file:/i.test(t)) {
    let url: URL
    try {
      url = new URL(t)
    } catch {
      return { ok: false, reason: `That picture's address isn't valid: ${href}` }
    }
    if (url.host && url.host.toLowerCase() !== 'localhost') return { ok: false, reason: 'Pictures on network shares are not loaded.' }
    t = url.pathname.replace(/^\/([a-z]:)/i, '$1')
  } else {
    // A query isn't part of a file's name: Windows names can't hold a ?. They can hold a #, as in "C# samples", so a
    // fragment is dropped only when the file with it isn't there (see `bare`).
    t = t.replace(/\?.*$/, '')
  }
  const one = (raw: string): { ok: true; path: string } | Fail => {
    let u = raw
    try {
      if (/%[0-9a-f]{2}/i.test(u)) u = decodeURIComponent(u)
    } catch {
      // Not encoded after all.
    }
    if (/[\0]/.test(u)) return { ok: false, reason: "That picture's address isn't valid." }
    if (/^[\\/]{2}/.test(u)) return { ok: false, reason: 'Pictures on network shares are not loaded.' }
    const full = normalize(isAbsolute(u) && /^[a-z]:/i.test(u) ? u : resolve(dirname(docPath), u))
    if (/^[\\/]{2}/.test(full)) return { ok: false, reason: 'Pictures on network shares are not loaded.' }
    const name = full.split(/[\\/]/).pop() ?? ''
    // A colon in a name is a stream of another file; a trailing dot or space names the same file without them.
    if (/:/.test(name) || /[. ]$/.test(name)) return { ok: false, reason: `That picture's address isn't valid: ${href}` }
    return { ok: true, path: full }
  }
  const whole = one(t)
  if (!whole.ok) return whole
  const hash = t.indexOf('#')
  const bare = hash > 0 ? one(t.slice(0, hash)) : null
  return bare?.ok && bare.path !== whole.path ? { ...whole, bare: bare.path } : whole
}

/**
 * The folders a document's pictures may come from, the same limits the Reader has for the document itself. One an
 * agent opened: that agent's folders (its own, its group's worktree, its project's, ~/.claude/plans), or, once the
 * agent is gone, the document's folder and its project's. One the person opened: the document's folder and its
 * project's.
 */
export function imageFolders(doc: CanvasDoc, reader: ReaderNode, home: string): string[] {
  if (reader.openedBy) {
    const agent = doc.nodes.find((n) => n.id === reader.openedBy)
    if (agent) return agentFolders(doc, agent, home)
  }
  const project = doc.projects.find((p) => p.id === (reader.projectId ?? doc.activeProjectId))
  return [dirname(reader.path), ...(project?.folder ? [project.folder] : [])]
}

export interface ImageFs extends LinkFs {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<Pick<Stats, 'isFile' | 'size'>>
  readBytes(path: string): Promise<Uint8Array>
}

const nodeFs: ImageFs = { realpath: (p) => realpath(p), stat: (p) => stat(p), readBytes: (p) => readFile(p), lstat: (p) => lstat(p), readlink: (p) => readlink(p) }

/** Pictures read at once. Each can be 8 MB and a third more as base64, so a long list of them waits its turn. */
export const PICTURE_READS_AT_ONCE = 3

/** Runs at most `n` of the given jobs at a time, in the order they came. */
export function limiter(n: number): <T>(job: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  return async (job) => {
    if (running >= n) await new Promise<void>((go) => waiting.push(go))
    running++
    try {
      return await job()
    } finally {
      running--
      waiting.shift()?.()
    }
  }
}

type Missing = { ok: false; reason: string; missing: true }

/** Reads a document's pictures for the window within the limits above, a few at a time. */
export function createImageReader(d: { store: CanvasStore; home: string; system?: string[]; fs?: ImageFs }) {
  const system = d.system ?? systemFolders()
  const fs = d.fs ?? nodeFs
  const blockedBy = (path: string): string | undefined => system.find((f) => insideFolder(path, f))
  const queue = limiter(PICTURE_READS_AT_ONCE)
  // The same file asked for again while it's being read (as shot.png?1 and shot.png?2) is read once.
  const reading = new Map<string, Promise<ImageResult>>()

  const read = async (path: string, allowed: (p: string) => boolean): Promise<ImageResult | Missing> => {
    const outside: Fail = { ok: false, reason: `The picture is outside the folders this document may show from: ${path}` }
    const ext = extOf(path)
    if (!IMAGE_EXTENSIONS.includes(ext)) return { ok: false, reason: `Only pictures are shown (${IMAGE_EXTENSIONS.join(', ')}).` }
    if (!allowed(path)) return outside
    // Before realpath, which would open a link to a network share and so connect to it.
    const links = await linksStayLocal(path, fs)
    if (!links.ok) return { ok: false, reason: links.reason }
    let real: string
    try {
      real = await fs.realpath(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: `The picture isn't there: ${path}`, missing: true }
      return { ok: false, reason: `The picture can't be read: ${(e as Error).message}` }
    }
    // Followed through links and junctions, it must still be somewhere allowed, and still a picture.
    if (/^[\\/]{2}/.test(real) || !allowed(real) || extOf(real) !== ext) return outside
    try {
      const st = await fs.stat(real)
      if (!st.isFile()) return { ok: false, reason: `That isn't a file: ${path}` }
      if (st.size > MAX_IMAGE_BYTES) return { ok: false, reason: `The picture is ${Math.round(st.size / 1024 / 1024)} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB shown here.` }
      const bytes = await fs.readBytes(real)
      if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: `The picture is over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB shown here.` }
      const mime = sniffImage(bytes, ext)
      if (!mime) return { ok: false, reason: `${path} isn't a picture this can show.` }
      return { ok: true, url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`, path }
    } catch (e) {
      return { ok: false, reason: `The picture can't be read: ${(e as Error).message}` }
    }
  }

  return async function image(nodeId: string, href: string): Promise<ImageResult> {
    const doc = d.store.get()
    const reader = doc.nodes.find((n) => n.id === nodeId)
    if (reader?.kind !== 'reader') return { ok: false, reason: 'That reader is no longer on the canvas.' }
    const at = imagePath(reader.path, href)
    if (!at.ok) return at
    const folders = imageFolders(doc, reader, d.home)
    const allowed = (p: string): boolean => !blockedBy(p) && folders.some((f) => insideFolder(p, f))
    const key = `${nodeId}\n${at.path}\n${at.bare ?? ''}`
    const known = reading.get(key)
    if (known) return known
    const job = queue(async (): Promise<ImageResult> => {
      // "x.png#dark" names x.png: no picture is named .png#dark. "C# samples/ui.png" is tried as it is first.
      if (at.bare && !IMAGE_EXTENSIONS.includes(extOf(at.path))) {
        const r = await read(at.bare, allowed)
        return r.ok ? r : { ok: false, reason: r.reason }
      }
      const r = await read(at.path, allowed)
      const out = !r.ok && 'missing' in r && at.bare ? await read(at.bare, allowed) : r
      return out.ok ? out : { ok: false, reason: out.reason }
    }).finally(() => reading.delete(key))
    reading.set(key, job)
    return job
  }
}
