import { isAbsolute, normalize, resolve } from 'node:path'
import { DOC_EXTENSIONS, isDocPath } from '../../shared/reader'

/** The largest file a reader opens. A plan is a few kilobytes; this is far past any document someone reads. */
export const MAX_DOC_BYTES = 4 * 1024 * 1024

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string }

/** Folders a reader never opens from: Windows itself and installed programs. */
export function systemFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.SystemRoot ?? env.windir ?? 'C:\\Windows', env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.ProgramData ?? 'C:\\ProgramData']
}

const under = (path: string, folder: string): boolean => {
  const p = path.toLowerCase().replace(/[\\/]+$/, '')
  const f = folder.toLowerCase().replace(/[\\/]+$/, '')
  return p === f || p.startsWith(`${f}\\`) || p.startsWith(`${f}/`)
}

/**
 * Whether a reader may open this path: a Markdown or text file on a local drive, outside Windows and Program Files.
 * Checked when a reader is opened and again at every read, and against the real path once symlinks are followed.
 */
export function checkDocPath(path: string, system: string[] = systemFolders()): PathCheck {
  const raw = path.trim()
  if (!raw) return { ok: false, reason: 'No file was given.' }
  // UNC shares, and \\?\ and \\.\ device paths. A share could be slow or hand over credentials just by being read.
  if (/^[\\/]{2}/.test(raw)) return { ok: false, reason: `Network and device paths can't be opened in a reader: ${raw}` }
  if (!isAbsolute(raw)) return { ok: false, reason: `The path must be a full path: ${raw}` }
  if (/[\0]/.test(raw)) return { ok: false, reason: 'That path isn\'t valid.' }
  // Windows reads a:b.md as stream b.md of file a; and a trailing dot or space names the same file without them.
  const name = raw.split(/[\\/]/).pop() ?? ''
  if (/:/.test(name) || /[. ]$/.test(name)) return { ok: false, reason: `That path isn't valid: ${raw}` }
  const full = normalize(resolve(raw))
  if (!isDocPath(full)) return { ok: false, reason: `A reader opens Markdown and text files (${DOC_EXTENSIONS.join(', ')}), not ${name}.` }
  const blocked = system.find((f) => under(full, f))
  if (blocked) return { ok: false, reason: `Files under ${blocked} can't be opened in a reader.` }
  return { ok: true, path: full }
}

/** The same file however its path is written, for keeping its comments: resolved, and case-folded as Windows is. */
export function docKey(path: string): string {
  const full = normalize(resolve(path))
  return process.platform === 'win32' ? full.toLowerCase() : full
}
