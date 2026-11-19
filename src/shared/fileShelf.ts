/**
 * The Files shelf and file icons: which files were shared in a project, and how a path is shown, compared and typed.
 * Pure, so main, the page and tests share one reading. The shelf holds references to files, never copies.
 */
import type { ShellKind } from './terminalProfiles'

/** Where a file on the shelf came from. `doc` and `touched` are for the doc viewer and files-touched to note. */
export type ShelfSource = 'paste' | 'drop' | 'pin' | 'agent' | 'evidence' | 'doc' | 'touched'

export const SOURCE_LABELS: Record<ShelfSource, string> = {
  paste: 'Pasted image',
  drop: 'Dropped',
  pin: 'Pinned to canvas',
  agent: 'Pinned by an agent',
  evidence: 'Browser evidence',
  doc: 'Opened in the doc viewer',
  touched: 'Edited by an agent'
}

export interface ShelfEntry {
  path: string
  source: ShelfSource
  /** When it was last shared, in ms. */
  at: number
  /** The window it was shared with or by, as it was titled then. */
  nodeTitle?: string
}

/** Per project, the oldest dropped past this. */
export const SHELF_LIMIT = 2000

const SOURCES = new Set<string>(Object.keys(SOURCE_LABELS))

export function isShelfEntry(v: unknown): v is ShelfEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.path === 'string' &&
    e.path.length > 0 &&
    typeof e.source === 'string' &&
    SOURCES.has(e.source) &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    (e.nodeTitle === undefined || typeof e.nodeTitle === 'string')
  )
}

/** `\\?\C:\a` is C:\a, and `\\?\UNC\server\share` is \\server\share: the long-path prefix changes nothing about the file. */
export function withoutLongPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`
  if (/^\\\\\?\\[A-Za-z]:/.test(path)) return path.slice(4)
  return path
}

/** One file, however it's written: Windows paths ignore case and slash direction, and a trailing separator. */
export function pathKey(path: string): string {
  return withoutLongPrefix(path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** `\\server\share\...`, which Windows reaches over the network. Touching one can send the person's credentials there. */
export function isNetworkPath(path: string): boolean {
  const p = withoutLongPrefix(path)
  return /^[\\/]{2}/.test(p) && !/^[\\/]{2}[.?][\\/]/.test(p)
}

/** `\\.\` and `\\?\` paths other than a long drive path name devices and volumes, not files. */
export function isDevicePath(path: string): boolean {
  return /^[\\/]{2}[.?][\\/]/.test(withoutLongPrefix(path))
}

/** Adds or moves a file to the top, newest first, keeping at most `limit`. One entry per file. */
export function noteEntry(list: ShelfEntry[], entry: ShelfEntry, limit = SHELF_LIMIT): ShelfEntry[] {
  const key = pathKey(entry.path)
  const rest = list.filter((e) => pathKey(e.path) !== key)
  return [entry, ...rest].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit))
}

export function forgetEntry(list: ShelfEntry[], path: string): ShelfEntry[] {
  const key = pathKey(path)
  return list.filter((e) => pathKey(e.path) !== key)
}

const parts = (path: string): string[] => withoutLongPrefix(path).split(/[\\/]+/).filter(Boolean)

/** The file's own name, as an icon shows it. */
export function fileName(path: string): string {
  const all = parts(path)
  return all[all.length - 1] ?? path
}

/** A short hint of where it is: the folder it's in, or the share for a file at the top of one. */
export function folderHint(path: string): string {
  const p = withoutLongPrefix(path)
  const all = parts(p)
  if (all.length < 2) return p
  if (isNetworkPath(p) && all.length <= 3) return `\\\\${all[0]}\\${all[1]}`
  if (all.length === 2 && /^[A-Za-z]:$/.test(all[0])) return `${all[0]}\\`
  return `…\\${all[all.length - 2]}`
}

/** The folder holding a file. */
export function parentFolder(path: string): string {
  const p = withoutLongPrefix(path).replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (i <= 0) return p
  const head = p.slice(0, i)
  return /^[A-Za-z]:$/.test(head) ? `${head}\\` : head
}

export type FileKind = 'image' | 'pdf' | 'document' | 'sheet' | 'code' | 'data' | 'archive' | 'media' | 'program' | 'other'
/** The shelf's type filter: kinds grouped as a person would look for them. */
export type KindFilter = 'all' | 'images' | 'documents' | 'code' | 'data' | 'other'

const EXT: Record<string, FileKind> = {}
const add = (kind: FileKind, list: string): void => list.split(' ').forEach((e) => (EXT[e] = kind))
add('image', 'png jpg jpeg gif webp bmp svg ico tif tiff heic avif')
add('pdf', 'pdf')
add('document', 'md markdown txt rtf doc docx odt pptx ppt key pages html htm log')
add('sheet', 'xls xlsx ods numbers')
add('code', 'ts tsx js jsx mjs cjs py rb go rs java kt c h cpp hpp cs swift php sh bash ps1 psm1 bat cmd css scss sql lua vue svelte')
add('data', 'json jsonl yaml yml toml xml csv tsv ini env lock')
add('archive', 'zip 7z rar tar gz tgz bz2 xz')
add('media', 'mp3 wav ogg flac m4a mp4 mov webm mkv avi')
add('program', 'exe msi com scr lnk url appref-ms')

export function fileKind(path: string): FileKind {
  const name = fileName(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (EXT[name.slice(dot + 1)] ?? 'other') : 'other'
}

export function kindFilterOf(kind: FileKind): Exclude<KindFilter, 'all'> {
  if (kind === 'image') return 'images'
  if (kind === 'pdf' || kind === 'document' || kind === 'sheet') return 'documents'
  if (kind === 'code') return 'code'
  if (kind === 'data') return 'data'
  return 'other'
}

export const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'All types' },
  { id: 'images', label: 'Images' },
  { id: 'documents', label: 'Documents' },
  { id: 'code', label: 'Code' },
  { id: 'data', label: 'Data' },
  { id: 'other', label: 'Other' }
]

/** What the shelf shows for a search and a type: every word must be in the name or path, any case. */
export function filterEntries(list: ShelfEntry[], query: string, kind: KindFilter): ShelfEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return list.filter((e) => {
    if (kind !== 'all' && kindFilterOf(fileKind(e.path)) !== kind) return false
    const hay = withoutLongPrefix(e.path).toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** Who a path is typed for: a terminal's shell, or an agent's own prompt. */
export type PathTarget = ShellKind | 'agent'

/**
 * A path as it should be typed into a window, quoted for what reads it, with a space after so the next word stands
 * apart. Windows file names can't hold `"`, so double quotes need no escaping.
 */
export function quotePathFor(path: string, target: PathTarget): string {
  const p = withoutLongPrefix(path)
  switch (target) {
    case 'powershell':
      // PowerShell takes the curly single quotes as quotes too, so they're doubled like the straight one.
      return `'${p.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}' `
    case 'git-bash':
      return `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}' `
    case 'bash':
    case 'wsl': {
      const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p)
      const linux = drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}` : p.replace(/\\/g, '/')
      return `'${linux.replace(/'/g, `'\\''`)}' `
    }
    case 'cmd':
      return `"${p}" `
    case 'agent':
    case 'other':
      return /[\s&()^%!;,'`=]/.test(p) ? `"${p}" ` : `${p} `
  }
}

/** What "Send path to agent" sends. */
export function pathMessage(path: string): string {
  return `Have a look at this file: "${withoutLongPrefix(path)}"`
}

export type PinCheck = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Whether an agent may put this path on the canvas. It must be a full path on a drive: a network share is refused,
 * since Patchbay checking or opening it would send the person's Windows credentials to that server.
 */
export function checkAgentPath(raw: string): PinCheck {
  const path = withoutLongPrefix(raw.trim())
  if (!path) return { ok: false, reason: '--path is required.' }
  if (isNetworkPath(path)) return { ok: false, reason: `Network paths can't be pinned by an agent: ${raw}. Ask the person to drag the file onto the canvas.` }
  if (isDevicePath(path)) return { ok: false, reason: `That's a device path, not a file: ${raw}` }
  if (!/^[A-Za-z]:[\\/]/.test(path)) return { ok: false, reason: `--path must be a full path, like C:\\work\\report.pdf: ${raw}` }
  return { ok: true, path }
}

/** A file icon's size on the canvas. */
export const FILE_NODE_SIZE = { width: 120, height: 112 }

/** What a file is now: there, a folder, gone, or not looked at (a network path nobody asked to be touched). */
export type FileState = 'file' | 'folder' | 'missing' | 'unchecked'

/** Asks main to look at these files. `network` says the person added it, so a network path may be touched. */
export interface FileCheckItem {
  path: string
  network?: boolean
}

export type FileActionResult = { ok: true; revealed?: boolean } | { ok: false; reason: string }

/** The shelf's and file icons' calls to main, on `window.patchbayFiles`. Served in src/main/fileShelf/ipc.ts. */
export interface FileShelfBridge {
  list(projectId: string): Promise<ShelfEntry[]>
  note(projectId: string, entries: ShelfEntry[]): Promise<void>
  forget(projectId: string, path: string): Promise<void>
  check(items: FileCheckItem[]): Promise<Record<string, FileState>>
  open(path: string): Promise<FileActionResult>
  reveal(path: string): Promise<FileActionResult>
  /** A project's shelf changed. Returns a function that stops listening. */
  onChanged(cb: (projectId: string) => void): () => void
  /** The path of a file dragged in from File Explorer, or '' for something that isn't a file on disk. */
  pathForFile(file: File): string
}
