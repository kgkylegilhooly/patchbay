import { posix, win32 } from 'node:path'
import type { DiffScope, FilesSummary, OverlapNote, TouchedFile, TurnMark } from '../../shared/filesTouched'
import { createEventReader, type TranscriptEvent } from '../../core/search/transcriptEvents'

/**
 * Which files an agent session edited, kept per node. Pure: the service in src/main/files does the reading, git and
 * saving. See docs/plans/files-touched.md.
 */

/** Files kept per session. The oldest are dropped past this, and the list says so. */
export const MAX_FILES = 300
/** Turns kept per session, each with its snapshot. */
export const MAX_TURNS = 30
/** How long a record outlives its node leaving the canvas. */
export const KEEP_CLOSED_MS = 3 * 24 * 3600_000

export interface SessionRecord {
  nodeId: string
  cwd: string
  /** The transcript the offset belongs to. Another one (after /clear, or a new session) is read from its start. */
  transcriptPath: string | null
  /** Bytes of the transcript already read, up to the end of a complete line. */
  offset: number
  files: TouchedFile[]
  turns: TurnMark[]
  truncated: boolean
  /** The last time its node was on the canvas. */
  seenAt: number
  /** Bytes read of each subagent transcript (by file name) of the current conversation, as `offset` is for its own. */
  subagents?: Record<string, number>
}

export function emptyRecord(nodeId: string, cwd: string, now: number): SessionRecord {
  return { nodeId, cwd, transcriptPath: null, offset: 0, files: [], turns: [], truncated: false, seenAt: now }
}

/**
 * A path as one absolute Windows or POSIX path. Git Bash's /c/Users/me form becomes C:\Users\me on Windows, and a
 * relative path (as Codex's patches give) is taken from the session's folder.
 */
export function normalizePath(cwd: string, path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const bash = /^\/([a-zA-Z])(\/.*)?$/.exec(path)
    const p = bash ? `${bash[1].toUpperCase()}:${bash[2] ?? '\\'}` : path
    const full = win32.resolve(win32.isAbsolute(p) ? p : win32.join(cwd, p))
    return full.replace(/^[a-z]:/, (d) => d.toUpperCase())
  }
  return posix.resolve(cwd, path)
}

/** Two spellings of one file compare equal: Windows paths ignore case. */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.toLowerCase() : path
}

/** The turn an edit at this time belongs to: the last one started at or before it. */
export function turnAt(turns: TurnMark[], at: number): number | null {
  let found: number | null = null
  for (const t of turns) if (t.at <= at) found = t.turn
  return found
}

export interface EditSeen {
  path: string
  at: number
  confirmed: boolean
  /** Made by one of the session's subagents, read from its own transcript. */
  subagent?: boolean
}

/** Adds an edit to a record. Returns false when it changed nothing: the same edit read twice. */
export function addEdit(rec: SessionRecord, edit: EditSeen, platform: NodeJS.Platform = process.platform): boolean {
  const path = normalizePath(rec.cwd, edit.path, platform)
  const key = pathKey(path, platform)
  const turn = turnAt(rec.turns, edit.at)
  const mark = turn === null ? undefined : rec.turns.find((t) => t.turn === turn)
  if (mark && (mark.firstEditAt === undefined || edit.at < mark.firstEditAt)) mark.firstEditAt = edit.at
  const file = rec.files.find((f) => pathKey(f.path, platform) === key)
  if (file) {
    // Read again from an earlier offset after a restart: the same file at the same moment is the same edit.
    if (file.edits > 0 && (edit.at === file.lastAt || edit.at === file.firstAt)) {
      if (!edit.confirmed || file.confirmed) return false
      file.confirmed = true
      return true
    }
    // An edit read late, after the turn's end found the change: it was the session's own after all.
    if (turn !== null && file.changedInTurns?.includes(turn)) {
      file.changedInTurns = file.changedInTurns.filter((t) => t !== turn)
      if (!file.changedInTurns.length) delete file.changedInTurns
    }
    if (file.edits === 0) {
      // Known so far only as changed during a turn: this is its first edit of its own.
      file.firstAt = edit.at
      file.firstTurn = turn
      file.confirmed = edit.confirmed
    }
    if (edit.at < file.firstAt) {
      file.firstAt = edit.at
      file.firstTurn = turn
    }
    if (edit.at > file.lastAt) {
      file.lastAt = edit.at
      file.lastTurn = turn
    }
    file.edits += 1
    if (edit.subagent) file.bySubagent = (file.bySubagent ?? 0) + 1
    file.confirmed ||= edit.confirmed
    return true
  }
  rec.files.push({ path, firstAt: edit.at, lastAt: edit.at, firstTurn: turn, lastTurn: turn, edits: 1, confirmed: edit.confirmed, ...(edit.subagent ? { bySubagent: 1 } : {}) })
  bound(rec)
  return true
}

function bound(rec: SessionRecord): void {
  if (rec.files.length > MAX_FILES) {
    rec.files.sort((a, b) => b.lastAt - a.lastAt)
    rec.files.length = MAX_FILES
    rec.truncated = true
  }
}

/** At most this many files are taken from one turn's end check, so one big generated folder can't fill the list. */
export const MAX_TURN_CHANGES = 100

/**
 * Files that differ between a turn's snapshot and the checkout as the turn ended, with no edit of them in that turn's
 * transcripts (the session's own or its subagents'). A shell command it ran, or another process, changed them. They
 * are recorded as changed during the turn, never as the agent's edits. Returns how many were taken, and how many more
 * there were.
 */
export function addTurnChanges(rec: SessionRecord, turn: number, paths: string[], at: number, root: string, platform: NodeJS.Platform = process.platform): { taken: number; more: number } {
  let taken = 0
  let more = 0
  for (const rel of paths) {
    const path = normalizePath(root, rel, platform)
    const key = pathKey(path, platform)
    const file = rec.files.find((f) => pathKey(f.path, platform) === key)
    // Edited in this very turn according to the transcripts: the change is explained.
    if (file && file.edits > 0 && (file.lastTurn === turn || file.firstTurn === turn) && !file.changedInTurns?.includes(turn)) continue
    if (file?.changedInTurns?.includes(turn)) continue
    if (taken >= MAX_TURN_CHANGES) {
      more++
      continue
    }
    taken++
    if (file) {
      file.changedInTurns = [...(file.changedInTurns ?? []), turn].slice(-MAX_TURNS)
      if (at > file.lastAt) {
        file.lastAt = at
        file.lastTurn = turn
      }
    } else {
      rec.files.push({ path, firstAt: at, lastAt: at, firstTurn: turn, lastTurn: turn, edits: 0, confirmed: true, changedInTurns: [turn] })
    }
  }
  bound(rec)
  return { taken, more }
}

/** Marks a turn as started. Its snapshot is filled in once git has made it. */
export function startTurn(rec: SessionRecord, at: number): TurnMark {
  const mark: TurnMark = { turn: (rec.turns.at(-1)?.turn ?? 0) + 1, at, root: null, tree: null, head: null }
  rec.turns.push(mark)
  if (rec.turns.length > MAX_TURNS) rec.turns.splice(0, rec.turns.length - MAX_TURNS)
  return mark
}

/** Files edited in one turn, newest first. */
export function filesInTurn(rec: SessionRecord, turn: number): TouchedFile[] {
  return rec.files.filter((f) => f.lastTurn === turn || f.firstTurn === turn).sort((a, b) => b.lastAt - a.lastAt)
}

/**
 * The snapshot a diff of this file starts from, or null when there isn't one (the diff is then against HEAD). For the
 * session, that's the turn that first edited it; when that turn has been dropped, the oldest one kept, and `exact` is
 * false.
 */
export function diffBase(rec: SessionRecord, file: TouchedFile, scope: DiffScope): { mark: TurnMark; exact: boolean } | null {
  if (scope === 'turn') {
    const mark = rec.turns.at(-1)
    return mark?.tree ? { mark, exact: true } : null
  }
  if (file.firstTurn === null) return null
  const mark = rec.turns.find((t) => t.turn === file.firstTurn)
  if (mark) return mark.tree ? { mark, exact: true } : null
  const oldest = rec.turns.find((t) => t.tree && t.turn > file.firstTurn!)
  return oldest ? { mark: oldest, exact: false } : null
}

/**
 * The files two or more live sessions edited. Each path is one file in one checkout, so the same path in two records
 * means the same file. `live` gives a live node's title, or null.
 */
export function findOverlaps(records: Iterable<SessionRecord>, live: (nodeId: string) => string | null, platform: NodeJS.Platform = process.platform): Map<string, Record<string, OverlapNote[]>> {
  const byPath = new Map<string, { path: string; nodeId: string; title: string }[]>()
  for (const rec of records) {
    const title = live(rec.nodeId)
    if (title === null) continue
    for (const f of rec.files) {
      // Only edits count: a file a command changed during a turn is not the session's edit, so it warns nobody.
      if (f.edits === 0) continue
      const key = pathKey(f.path, platform)
      const list = byPath.get(key) ?? []
      list.push({ path: f.path, nodeId: rec.nodeId, title })
      byPath.set(key, list)
    }
  }
  const out = new Map<string, Record<string, OverlapNote[]>>()
  for (const list of byPath.values()) {
    if (list.length < 2) continue
    for (const mine of list) {
      const notes = out.get(mine.nodeId) ?? {}
      notes[mine.path] = list.filter((o) => o.nodeId !== mine.nodeId).map((o) => ({ nodeId: o.nodeId, title: o.title }))
      out.set(mine.nodeId, notes)
    }
  }
  return out
}

/** What each node's chip shows. Nodes with nothing touched are left out. */
export function summarize(records: Iterable<SessionRecord>, overlaps: Map<string, Record<string, OverlapNote[]>>): FilesSummary {
  const out: FilesSummary = {}
  for (const rec of records) {
    if (rec.files.length === 0) continue
    const edited = rec.files.filter((f) => f.edits > 0).length
    const changed = rec.files.length - edited
    out[rec.nodeId] = { count: edited, overlap: Object.keys(overlaps.get(rec.nodeId) ?? {}).length, ...(changed ? { changed } : {}) }
  }
  return out
}

/**
 * Keeps records whose node is on the canvas (noting it was seen now) or left it recently. Returns the ids dropped.
 */
export function pruneRecords(records: Map<string, SessionRecord>, onCanvas: Set<string>, now: number): string[] {
  const dropped: string[] = []
  for (const [id, rec] of records) {
    if (onCanvas.has(id)) rec.seenAt = now
    else if (now - rec.seenAt > KEEP_CLOSED_MS) {
      records.delete(id)
      dropped.push(id)
    }
  }
  return dropped
}

type EditEvent = Extract<TranscriptEvent, { kind: 'edit' }>

/**
 * Reads a transcript's lines as they're added and hands back its file edits once their results are known. An edit
 * whose result never comes is handed back unconfirmed when the turn is over. Failed edits are dropped.
 */
export function createEditCollector(): {
  /** One complete line, and where in the file it starts. */
  line(text: string, start: number): void
  /** Edits whose outcome is known, or every one still open when `turnOver`. */
  take(turnOver: boolean, now: number): EditSeen[]
  /** Where reading again would find every edit not yet handed back: the start of the oldest one still open. */
  safeOffset(read: number): number
} {
  const reader = createEventReader()
  let open: { event: EditEvent; start: number }[] = []
  return {
    line(text, start) {
      for (const e of reader.line(text)) if (e.kind === 'edit') open.push({ event: e, start })
    },
    take(turnOver, now) {
      const out: EditSeen[] = []
      const still: typeof open = []
      for (const o of open) {
        const { ok, path, at } = o.event
        if (ok === false) continue
        if (ok === true || turnOver) out.push({ path, at: at ?? now, confirmed: ok === true })
        else still.push(o)
      }
      open = still
      return out
    },
    safeOffset(read) {
      return open.reduce((min, o) => Math.min(min, o.start), read)
    }
  }
}

function isFile(v: unknown): v is TouchedFile {
  const f = v as TouchedFile
  return !!f && typeof f.path === 'string' && typeof f.firstAt === 'number' && typeof f.lastAt === 'number' && typeof f.edits === 'number' && typeof f.confirmed === 'boolean'
}

function isTurn(v: unknown): v is TurnMark {
  const t = v as TurnMark
  return !!t && typeof t.turn === 'number' && typeof t.at === 'number'
}

/** Records from a saved file. Anything damaged is left out rather than failing the rest. */
export function parseRecords(text: string | null): Map<string, SessionRecord> {
  const out = new Map<string, SessionRecord>()
  if (!text) return out
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return out
  }
  const list = (raw as { sessions?: unknown })?.sessions
  if (!Array.isArray(list)) return out
  for (const r of list as Partial<SessionRecord>[]) {
    if (!r || typeof r.nodeId !== 'string' || typeof r.cwd !== 'string') continue
    out.set(r.nodeId, {
      nodeId: r.nodeId,
      cwd: r.cwd,
      transcriptPath: typeof r.transcriptPath === 'string' ? r.transcriptPath : null,
      offset: typeof r.offset === 'number' && r.offset >= 0 ? r.offset : 0,
      files: Array.isArray(r.files) ? r.files.filter(isFile).map((f) => ({ ...f, firstTurn: f.firstTurn ?? null, lastTurn: f.lastTurn ?? null })).slice(0, MAX_FILES) : [],
      turns: Array.isArray(r.turns) ? r.turns.filter(isTurn).map((t) => ({ ...t, root: t.root ?? null, tree: t.tree ?? null, head: t.head ?? null })).slice(-MAX_TURNS) : [],
      truncated: r.truncated === true,
      seenAt: typeof r.seenAt === 'number' ? r.seenAt : Date.now(),
      ...(r.subagents && typeof r.subagents === 'object' ? { subagents: Object.fromEntries(Object.entries(r.subagents).filter((e): e is [string, number] => /^agent-[A-Za-z0-9_-]{1,80}\.jsonl$/.test(e[0]) && typeof e[1] === 'number' && e[1] >= 0)) } : {})
    })
  }
  return out
}

export function serializeRecords(records: Map<string, SessionRecord>): string {
  return JSON.stringify({ version: 1, sessions: [...records.values()] })
}
