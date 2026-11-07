/**
 * A project's kanban board. It only records which column each card sits in: moving a card never touches the session
 * behind it. Cards are keyed by node id for sessions, and `issue:<number>` for GitHub issues.
 */

export interface BoardColumn {
  id: string
  title: string
  /** Dropping an issue here offers to start a Claude node on it. */
  startsWork?: boolean
}

export interface Board {
  columns: BoardColumn[]
  /** Card key to column id. A card with no entry, or one for a column that's gone, sits in the first column. */
  placement: Record<string, string>
  /** GitHub issues as cards, which the owner turns on per project. */
  issues?: { enabled: boolean; repo?: string }
  /** The session started on an issue, by issue card key. */
  started?: Record<string, string>
}

export type CardFilter = 'all' | 'sessions' | 'issues'

export const issueKey = (n: number): string => `issue:${n}`

export function defaultBoard(): Board {
  return {
    columns: [
      { id: 'todo', title: 'To do' },
      { id: 'doing', title: 'In progress', startsWork: true },
      { id: 'review', title: 'Review' },
      { id: 'done', title: 'Done' }
    ],
    placement: {}
  }
}

export function columnOf(board: Board, key: string): string {
  const id = board.placement[key]
  return id && board.columns.some((c) => c.id === id) ? id : board.columns[0].id
}

/** Every card key put in its column, in the order the keys came. */
export function cardsByColumn(board: Board, keys: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(board.columns.map((c) => [c.id, [] as string[]]))
  for (const key of keys) out[columnOf(board, key)].push(key)
  return out
}

export function moveCard(board: Board, key: string, columnId: string): Board {
  if (!board.columns.some((c) => c.id === columnId) || board.placement[key] === columnId) return board
  return { ...board, placement: { ...board.placement, [key]: columnId } }
}

export function addColumn(board: Board, id: string, title: string): Board {
  const name = title.trim()
  if (!name || board.columns.some((c) => c.id === id)) return board
  return { ...board, columns: [...board.columns, { id, title: name.slice(0, 60) }] }
}

export function renameColumn(board: Board, id: string, title: string): Board {
  const name = title.trim()
  if (!name) return board
  return { ...board, columns: board.columns.map((c) => (c.id === id ? { ...c, title: name.slice(0, 60) } : c)) }
}

export function moveColumn(board: Board, id: string, step: -1 | 1): Board {
  const i = board.columns.findIndex((c) => c.id === id)
  const j = i + step
  if (i === -1 || j < 0 || j >= board.columns.length) return board
  const columns = [...board.columns]
  ;[columns[i], columns[j]] = [columns[j], columns[i]]
  return { ...board, columns }
}

export function setStartsWork(board: Board, id: string, on: boolean): Board {
  return { ...board, columns: board.columns.map((c) => (c.id === id ? { ...c, startsWork: on || undefined } : c)) }
}

/**
 * Removes a column. Its cards move to the column before it, or the next one for the first, and the caller says so
 * first. The last column can't go.
 */
export function removeColumn(board: Board, id: string, keys: string[]): { board: Board; movedTo: string | null; moved: number } {
  const i = board.columns.findIndex((c) => c.id === id)
  if (i === -1 || board.columns.length === 1) return { board, movedTo: null, moved: 0 }
  const target = board.columns[i === 0 ? 1 : i - 1]
  const moving = keys.filter((k) => columnOf(board, k) === id)
  const placement: Record<string, string> = {}
  for (const [k, c] of Object.entries(board.placement)) if (c !== id) placement[k] = c
  for (const k of moving) placement[k] = target.id
  return { board: { ...board, columns: board.columns.filter((c) => c.id !== id), placement }, movedTo: target.id, moved: moving.length }
}

/** Placements for cards that no longer exist are dropped, so the saved board doesn't grow forever. */
export function prune(board: Board, liveKeys: string[]): Board {
  const live = new Set(liveKeys)
  const stale = Object.keys(board.placement).filter((k) => !live.has(k) && !k.startsWith('issue:'))
  if (stale.length === 0) return board
  const placement = { ...board.placement }
  for (const k of stale) delete placement[k]
  return { ...board, placement }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrRecord = (v: unknown): v is Record<string, string> => isObj(v) && Object.values(v).every((x) => typeof x === 'string')

/** A saved board as far as it can be trusted, or undefined. A damaged board is dropped, never the whole save. */
export function sanitizeBoard(raw: unknown): Board | undefined {
  if (!isObj(raw) || !Array.isArray(raw.columns)) return undefined
  const seen = new Set<string>()
  const columns: BoardColumn[] = []
  for (const c of raw.columns) {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.title !== 'string' || !c.id || seen.has(c.id)) continue
    seen.add(c.id)
    columns.push({ id: c.id, title: c.title.slice(0, 60), ...(c.startsWork === true ? { startsWork: true } : {}) })
  }
  if (columns.length === 0) return undefined
  const board: Board = { columns, placement: isStrRecord(raw.placement) ? raw.placement : {} }
  if (isObj(raw.issues) && typeof raw.issues.enabled === 'boolean') {
    board.issues = { enabled: raw.issues.enabled, ...(typeof raw.issues.repo === 'string' && raw.issues.repo ? { repo: raw.issues.repo } : {}) }
  }
  if (isStrRecord(raw.started)) board.started = raw.started
  return board
}
