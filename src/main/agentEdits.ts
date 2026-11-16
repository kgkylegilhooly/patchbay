import { readIfPresentSync, writeAtomic } from '../core/persist/atomicFile'
import type { AgentEdits, BoardEdit, NoteEdit } from '../shared/contract'

/** Edits kept, newest last, across every note and board. */
const KEPT = 200
const SAVE_AFTER_MS = 2000

export interface AgentEditLog {
  note(edit: NoteEdit): void
  board(edit: BoardEdit): void
  all(): AgentEdits
  /** The person kept or undid a node's changes, so they stop showing. */
  settle(id: string): void
  flush(): Promise<void>
}

const isEdit = (v: unknown): boolean => {
  const e = v as Record<string, unknown>
  return typeof e === 'object' && e !== null && typeof e.id === 'string' && typeof e.by === 'string' && typeof e.at === 'number'
}

function load(file: string | undefined): AgentEdits {
  if (!file) return { notes: [], boards: [] }
  try {
    const raw = JSON.parse(readIfPresentSync(file) ?? '{}') as Partial<AgentEdits>
    const notes = Array.isArray(raw.notes) ? raw.notes.filter((e) => isEdit(e) && typeof e.before === 'string' && typeof e.after === 'string') : []
    const boards = Array.isArray(raw.boards) ? raw.boards.filter((e) => isEdit(e) && typeof e.before === 'number' && typeof e.after === 'number') : []
    return { notes: notes.slice(-KEPT), boards: boards.slice(-KEPT) }
  } catch {
    return { notes: [], boards: [] }
  }
}

/**
 * What agents changed on notes and whiteboards, until the person keeps or undoes it, so a note or board can say who
 * changed it after the window reloads or the app restarts. Saved with the app, a moment after each change.
 */
export function createAgentEditLog(file?: string): AgentEditLog {
  const kept = load(file)
  let timer: NodeJS.Timeout | null = null
  const save = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    if (file) await writeAtomic(file, JSON.stringify(kept)).catch((e: unknown) => console.error('Patchbay could not save agent edits:', e))
  }
  const changed = (): void => {
    if (file && !timer) {
      timer = setTimeout(() => void save(), SAVE_AFTER_MS)
      timer.unref?.()
    }
  }
  return {
    note(edit) {
      kept.notes = [...kept.notes, edit].slice(-KEPT)
      changed()
    },
    board(edit) {
      kept.boards = [...kept.boards, edit].slice(-KEPT)
      changed()
    },
    all: () => ({ notes: [...kept.notes], boards: [...kept.boards] }),
    settle(id) {
      const notes = kept.notes.filter((e) => e.id !== id)
      const boards = kept.boards.filter((e) => e.id !== id)
      if (notes.length === kept.notes.length && boards.length === kept.boards.length) return
      kept.notes = notes
      kept.boards = boards
      changed()
    },
    flush: () => (timer ? save() : Promise.resolve())
  }
}
