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
export function chipLabel(count: number, overlap: number, changed = 0): { text: string; title: string } {
  const files = `${count} file${count === 1 ? '' : 's'}`
  // Files a command changed are counted apart, never as edited.
  const extra = changed ? ` +${changed} by commands` : ''
  const extraTitle = changed ? ` ${changed} more changed during its turns by a command or another process, not by its own edits.` : ''
  if (!overlap) return { text: `${files}${extra}`, title: `This session edited ${files}.${extraTitle} Click to see them` }
  return {
    text: `${files}${extra} · ${overlap} shared`,
    title: `This session edited ${files}. Another live agent also edited ${overlap} of them in the same checkout.${extraTitle} Click to see which`
  }
}

export interface OriginTag {
  text: string
  title: string
  kind: 'subagent' | 'command'
}

const turnList = (turns: number[]): string => (turns.length === 1 ? `turn ${turns[0]}` : `turns ${turns.join(', ')}`)

/**
 * Where a file's changes came from, beyond the session's own edits: its subagents, or a change found at the end of a
 * turn that no edit explains. The latter is never called the agent's edit: a command it ran, or another process, made it.
 */
export function originTags(file: TouchedFile): OriginTag[] {
  const tags: OriginTag[] = []
  const sub = file.bySubagent ?? 0
  if (sub > 0) {
    tags.push(
      sub >= file.edits
        ? { kind: 'subagent', text: 'by a subagent', title: "Edited by this session's subagents, read from their own transcripts" }
        : { kind: 'subagent', text: `${sub} of ${file.edits} edits by subagents`, title: "Some edits were made by this session's subagents, read from their own transcripts" }
    )
  }
  const turns = file.changedInTurns ?? []
  if (turns.length) {
    const title = 'The checkout at the end of the turn differed from its snapshot here, and no edit in the transcripts explains it. A shell command the agent ran, or another program, changed it'
    tags.push(
      file.edits === 0
        ? { kind: 'command', text: `changed during ${turnList(turns)} (by a command or another process)`, title }
        : { kind: 'command', text: `also changed during ${turnList(turns)} by a command or another process`, title }
    )
  }
  return tags
}

/** What the end of the latest turn found, or why it couldn't look, in a sentence. Null while the turn runs. */
export function endCheckNote(turn: { endCheck?: { changed: number; problem?: string } } | undefined): string | null {
  const c = turn?.endCheck
  if (!c) return null
  const found = c.changed ? `At its end, ${c.changed} file${c.changed === 1 ? '' : 's'} had changed that no edit explains, so a command or another process changed ${c.changed === 1 ? 'it' : 'them'}.` : ''
  return [found, c.problem ?? ''].filter(Boolean).join(' ') || null
}
