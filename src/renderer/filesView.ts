import { create } from 'zustand'
import type { FilesBridge, FilesSummary, SessionFiles, TouchedFile } from '../shared/filesTouched'

declare global {
  interface Window {
    patchbayFiles?: FilesBridge
  }
}

/** The files bridge. Missing only in a page without the preload, such as a test. */
export const files: FilesBridge | undefined = typeof window === 'undefined' ? undefined : window.patchbayFiles

/** Each node's chip: how many files, and how many another live agent also edited. Pushed by main. */
export const useFilesSummary = create<{ summary: FilesSummary }>(() => ({ summary: {} }))

let listening = false
/** Starts listening once, the first time a chip is drawn. */
export function listenForFiles(): void {
  if (listening || !files) return
  listening = true
  files.onSummary((summary) => useFilesSummary.setState({ summary }))
  void files.summary().then((summary) => useFilesSummary.setState({ summary }), () => undefined)
}

/** A file's name and the folder it's in, the folder shown relative to the session's own where it's inside it. */
export function splitPath(path: string, cwd: string): { name: string; folder: string } {
  const sep = path.includes('\\') ? '\\' : '/'
  const at = path.lastIndexOf(sep)
  const name = at === -1 ? path : path.slice(at + 1)
  let folder = at === -1 ? '' : path.slice(0, at)
  const base = cwd.replace(/[\\/]+$/, '')
  if (base && folder.toLowerCase() === base.toLowerCase()) folder = '.'
  else if (base && folder.toLowerCase().startsWith(`${base.toLowerCase()}${sep}`)) folder = folder.slice(base.length + 1)
  return { name, folder }
}

/** The files to list: all, or only those edited in the latest turn. Newest first. */
export function visibleFiles(data: SessionFiles, onlyTurn: boolean): TouchedFile[] {
  const latest = data.turns.at(-1)?.turn
  const list = onlyTurn ? data.files.filter((f) => latest !== undefined && (f.lastTurn === latest || f.firstTurn === latest)) : data.files
  return [...list].sort((a, b) => b.lastAt - a.lastAt)
}

/** The chip's words. */
export function chipLabel(count: number, overlap: number): { text: string; title: string } {
  const files = `${count} file${count === 1 ? '' : 's'}`
  if (!overlap) return { text: files, title: `This session edited ${files}. Click to see them` }
  return {
    text: `${files} · ${overlap} shared`,
    title: `This session edited ${files}. Another live agent also edited ${overlap} of them in the same checkout. Click to see which`
  }
}
