import { statSync } from 'node:fs'
import { checkAgentPath, fileName, isNetworkPath, type PinCheck } from '../../shared/fileShelf'
import type { FileNode } from '../../shared/model'

export type Lookup = (path: string) => 'file' | 'folder' | null

export const lookup: Lookup = (path) => {
  try {
    return statSync(path).isDirectory() ? 'folder' : 'file'
  } catch {
    return null
  }
}

/** What `patchbay pin-file --path P` may put on the canvas: a full path on a drive, to something that's there. */
export function checkPin(raw: string | undefined, look: Lookup = lookup): PinCheck & { title?: string } {
  if (raw === undefined) return { ok: false, reason: '--path is required.' }
  const checked = checkAgentPath(raw)
  if (!checked.ok) return checked
  if (!look(checked.path)) return { ok: false, reason: `File not found: ${checked.path}` }
  return { ok: true, path: checked.path, title: fileName(checked.path) }
}

/**
 * What `patchbay read` gives for a file icon linked to the caller: its path and whether it's there, never its contents.
 * The agent reads the file itself, with its own tools and permissions. A network path isn't touched.
 */
export function readFileNode(node: FileNode, look: Lookup = lookup): string {
  const state = isNetworkPath(node.path) ? 'on a network share (not checked)' : look(node.path) === 'folder' ? 'a folder' : look(node.path) ? 'there' : 'missing: it was moved or deleted'
  return `A file on the canvas: ${node.path}\nIt's ${state}. Read it with your own tools if you need what's in it.`
}
