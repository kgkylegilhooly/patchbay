import { basename, join, resolve } from 'node:path'
import type { CanvasStore } from '../../shared/contract'
import type { SaveHandoff, SaveHandoffResult } from '../../shared/searchBridge'
import { checkDocPath, systemFolders } from '../reader/policy'

/** A handoff is a few kilobytes; this only stops something that isn't one. */
export const MAX_SAVED_HANDOFF_CHARS = 1024 * 1024

/** A file name for a handoff, from its title: plain letters, digits and dashes. */
export function handoffFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${slug || 'handoff'}.md`
}

/** Where the person said to save, as a Markdown file: a name without .md or .markdown gets .md. */
export function asMarkdownPath(path: string): string {
  return /\.(md|markdown)$/i.test(path) ? path : `${path.replace(/[. ]+$/, '')}.md`
}

export interface HandoffSaverDeps {
  store: CanvasStore
  home: string
  /** The system save dialog, which asks before replacing a file. */
  pickFile(defaultPath: string): Promise<string | null>
  /** `exclusive` fails with EEXIST rather than replace a file. */
  writeFile(path: string, text: string, exclusive: boolean): Promise<void>
  system?: string[]
}

/**
 * "Save as file" in the handoff editor: the handoff as Markdown, where the person picks in the save dialog, starting in
 * the project's folder. The file must be one the Reader can open, so "Open in Reader" works on it.
 */
export function createHandoffSaver(d: HandoffSaverDeps) {
  const system = d.system ?? systemFolders()
  return async function saveHandoff(a: SaveHandoff): Promise<SaveHandoffResult> {
    if (!a || typeof a.text !== 'string' || !a.text.trim()) return { ok: false, reason: 'The handoff is empty.' }
    if (a.text.length > MAX_SAVED_HANDOFF_CHARS) return { ok: false, reason: 'The handoff is too long to save.' }
    const doc = d.store.get()
    const folder = (typeof a.projectId === 'string' && doc.projects.find((p) => p.id === a.projectId)?.folder) || d.home
    const picked = await d.pickFile(join(folder, handoffFileName(typeof a.title === 'string' ? a.title : '')))
    if (!picked) return { ok: false, cancelled: true, reason: 'Not saved.' }
    const check = checkDocPath(asMarkdownPath(picked), system)
    if (!check.ok) return { ok: false, reason: check.reason }
    // The dialog asked before replacing the name it gave. A name changed here wasn't asked about, so it never replaces.
    const changed = check.path.toLowerCase() !== resolve(picked).toLowerCase()
    try {
      await d.writeFile(check.path, a.text.endsWith('\n') ? a.text : `${a.text}\n`, changed)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: `${basename(check.path)} already exists. Save again and pick another name.` }
      return { ok: false, reason: `The handoff couldn't be saved: ${(e as Error).message}` }
    }
    return { ok: true, path: check.path }
  }
}
