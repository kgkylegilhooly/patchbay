import { open, stat } from 'node:fs/promises'
import { readIfPresentSync, writeAtomic } from '../../core/persist/atomicFile'
import { diffFile, EMPTY_TREE, insideRoot, objectEnv, pruneObjects, type RunGit, type Snapshot, type SnapshotStore } from './snapshot'
import {
  addEdit,
  createEditCollector,
  diffBase,
  emptyRecord,
  findOverlaps,
  normalizePath,
  parseRecords,
  pathKey,
  pruneRecords,
  serializeRecords,
  startTurn,
  summarize,
  type SessionRecord
} from './touched'
import type { DiffScope, FileDiff, FilesSummary, SessionFiles, TurnMark } from '../../shared/filesTouched'
import type { AgentStatus } from '../../shared/model'

/**
 * Which files each agent session edited, and a snapshot of its checkout as each turn started. Reads each session's
 * transcript as it grows; never changes the checkout. See docs/plans/files-touched.md.
 */

export interface AgentInfo {
  id: string
  title: string
  cwd: string
  transcriptPath: string | null
}

export interface FilesTouchedDeps {
  /** The agent nodes on the canvas now. */
  agents(): AgentInfo[]
  status(id: string): AgentStatus
  onStatus(cb: (id: string, status: AgentStatus) => void): void
  snapshot(cwd: string): Promise<Snapshot>
  git: RunGit
  /** Patchbay's own object folder, which snapshots write to and diffs read from. Without one, the repository's. */
  store?: SnapshotStore
  /** Where records are saved. None in tests. */
  file?: string
  push?(summary: FilesSummary): void
  now?(): number
  pollMs?: number
  saveAfterMs?: number
  log?(line: string): void
}

export interface FilesTouchedService {
  /** The files a node's session edited, read up to date first. Null for a node with no record. */
  files(nodeId: string): Promise<SessionFiles | null>
  /** The same for a conversation by its transcript, such as a closed session's. Not read again. */
  byTranscript(transcriptPath: string): SessionFiles | null
  diff(nodeId: string, path: string, scope: DiffScope): Promise<FileDiff>
  summary(): FilesSummary
  /** Reads a node's transcript now. `turnOver` hands back edits whose result never came, as unconfirmed. */
  scan(nodeId: string, turnOver?: boolean): Promise<void>
  /** Waits for snapshots and reads under way. For tests and quitting. */
  settled(): Promise<void>
  flush(): Promise<void>
  close(): void
}

const POLL_MS = 2500
const SAVE_AFTER_MS = 2000
/** A moved read offset alone is saved less often: it only saves rereading a little after a restart. */
const OFFSET_SAVE_AFTER_MS = 15_000
const PRUNE_EVERY_MS = 3600_000
/** Read at most this much of a transcript at once, with a pause for everything else between pieces. */
const CHUNK_BYTES = 1024 * 1024
/** A read with more than this to go is a backlog, such as a long conversation seen for the first time. */
const BACKLOG_BYTES = 1024 * 1024
/** Snapshot objects older than this are pruned, and the folder is kept under a size. */
const OBJECTS_MAX_AGE_MS = 10 * 24 * 3600_000
const OBJECTS_MAX_BYTES = 512 * 1024 * 1024
/** Snapshots run at most this many at a time: a team starting together would otherwise run git for each at once. */
const SNAPSHOTS_AT_ONCE = 2

const IN_TURN = new Set<AgentStatus>(['working', 'needs-you'])

/** What a diff is measured from, with warnings when the snapshot may not hold the turn's start exactly. */
export function diffLabel(base: TurnMark, scope: DiffScope, exact: boolean): string {
  const since =
    scope === 'turn'
      ? `since turn ${base.turn} started`
      : exact
        ? `since turn ${base.turn} started, when this session first edited it`
        : `since turn ${base.turn} started, the oldest snapshot still kept`
  const late = base.doneAt !== undefined && base.firstEditAt !== undefined && base.firstEditAt < base.doneAt
  const parts = [since]
  if (late) parts.push("The snapshot finished after that turn's first edit, so its earliest changes may not show")
  if (base.skipped) parts.push(`${base.skipped} untracked file${base.skipped === 1 ? ' was' : 's were'} too big or too many to go in that snapshot`)
  return parts.join('. ')
}

export function createFilesTouched(d: FilesTouchedDeps): FilesTouchedService {
  const now = d.now ?? Date.now
  const savedText = d.file ? readIfPresentSync(d.file) : null
  const records = parseRecords(savedText)
  if (savedText && records.size === 0 && !/"sessions"\s*:\s*\[\s*\]/.test(savedText)) d.log?.('The record of files sessions touched could not be read, so it starts again empty.')
  const collectors = new Map<string, { path: string; collector: ReturnType<typeof createEditCollector> }>()
  const last = new Map<string, AgentStatus>()
  const scans = new Map<string, Promise<void>>()
  const work = new Set<Promise<unknown>>()
  let closed = false
  let saveTimer: NodeJS.Timeout | null = null
  let lastSummary = ''

  const agent = (id: string): AgentInfo | undefined => d.agents().find((a) => a.id === id)
  const ensure = (a: AgentInfo): SessionRecord => {
    let rec = records.get(a.id)
    if (!rec) {
      rec = emptyRecord(a.id, a.cwd, now())
      records.set(a.id, rec)
    }
    rec.cwd = a.cwd
    return rec
  }
  const track = <T>(p: Promise<T>): Promise<T> => {
    work.add(p)
    void p.finally(() => work.delete(p)).catch(() => undefined)
    return p
  }

  const live = (): ((id: string) => string | null) => {
    const titles = new Map(d.agents().map((a) => [a.id, a.title]))
    return (id) => (titles.has(id) && d.status(id) !== 'exited' ? titles.get(id)! : null)
  }

  let saveDue = Infinity
  const save = async (): Promise<void> => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    saveDue = Infinity
    if (d.file) await writeAtomic(d.file, serializeRecords(records)).catch((e: unknown) => d.log?.(`Patchbay could not save the files sessions touched: ${String(e)}`))
  }
  /** Saves after `ms`, or sooner if a save is already due sooner. */
  const saveSoon = (ms = d.saveAfterMs ?? SAVE_AFTER_MS): void => {
    if (!d.file || closed) return
    const due = Date.now() + ms
    if (saveTimer && saveDue <= due) return
    if (saveTimer) clearTimeout(saveTimer)
    saveDue = due
    saveTimer = setTimeout(() => void save(), ms)
    saveTimer.unref?.()
  }
  /** Tells the window when what the chips show has changed. */
  const publish = (): void => {
    const summary = summarize(records.values(), findOverlaps(records.values(), live()))
    const text = JSON.stringify(summary)
    if (text !== lastSummary) {
      lastSummary = text
      d.push?.(summary)
    }
  }
  const changed = (): void => {
    saveSoon()
    publish()
  }

  /** Reads what was added to a node's transcript since last time. */
  const read = async (id: string, turnOver: boolean): Promise<void> => {
    const a = agent(id)
    if (!a?.transcriptPath) return
    const rec = ensure(a)
    let entry = collectors.get(id)
    if (rec.transcriptPath !== a.transcriptPath) {
      // Another conversation in the same node, after /clear or a fresh start: read from its beginning.
      rec.transcriptPath = a.transcriptPath
      rec.offset = 0
      entry = undefined
    }
    if (!entry || entry.path !== a.transcriptPath) {
      entry = { path: a.transcriptPath, collector: createEditCollector() }
      collectors.set(id, entry)
    }
    let size: number
    try {
      size = (await stat(a.transcriptPath)).size
    } catch {
      return
    }
    // Transcripts only grow. A shorter one has been replaced.
    if (size < rec.offset) {
      rec.offset = 0
      entry = { path: a.transcriptPath, collector: createEditCollector() }
      collectors.set(id, entry)
    }
    let at = rec.offset
    // A backlog waits behind any other, so a first start with many long conversations doesn't stall the app.
    const backlog = size - at > BACKLOG_BYTES
    if (backlog) await takeBacklog()
    try {
      if (at < size) await readFrom()
    } finally {
      if (backlog) giveBacklog()
    }
    async function readFrom(): Promise<void> {
      const handle = await open(a!.transcriptPath!, 'r')
      try {
        while (at < size) {
          if (at > rec.offset) await new Promise<void>((r) => setImmediate(r))
          const want = Math.min(CHUNK_BYTES, size - at)
          const buffer = Buffer.alloc(want)
          const { bytesRead } = await handle.read(buffer, 0, want, at)
          if (bytesRead === 0) break
          const bytes = buffer.subarray(0, bytesRead)
          const end = bytes.lastIndexOf(0x0a) + 1
          if (end === 0) {
            // One line longer than a chunk, or a line still being written. A huge line is skipped, not stuck on.
            if (bytesRead === CHUNK_BYTES) at += bytesRead
            break
          }
          let start = 0
          while (start < end) {
            const nl = bytes.indexOf(0x0a, start)
            entry!.collector.line(bytes.subarray(start, nl).toString('utf8'), at + start)
            start = nl + 1
          }
          at += end
        }
      } finally {
        await handle.close()
      }
    }
    let any = false
    for (const edit of entry.collector.take(turnOver, now())) any = addEdit(rec, edit) || any
    const offset = entry.collector.safeOffset(at)
    if (offset !== rec.offset) {
      rec.offset = offset
      // The offset alone is worth saving, but not soon, and not worth telling the window about.
      saveSoon(Math.max(d.saveAfterMs ?? SAVE_AFTER_MS, OFFSET_SAVE_AFTER_MS))
    }
    if (any) changed()
  }

  let backlogBusy = false
  const backlogQueue: (() => void)[] = []
  const takeBacklog = async (): Promise<void> => {
    if (backlogBusy) await new Promise<void>((r) => backlogQueue.push(r))
    backlogBusy = true
  }
  const giveBacklog = (): void => {
    backlogBusy = false
    backlogQueue.shift()?.()
  }

  const scan = (id: string, turnOver = false): Promise<void> => {
    // One read at a time per node; a call during one waits for it, then reads what came after.
    const before = scans.get(id) ?? Promise.resolve()
    const next = before.then(() => read(id, turnOver)).catch((e: unknown) => d.log?.(`Reading what ${id} edited failed: ${String(e)}`))
    scans.set(id, next)
    void next.then(() => {
      if (scans.get(id) === next) scans.delete(id)
    })
    return track(next)
  }

  let running = 0
  const waiting: (() => void)[] = []
  /** A turn's own snapshot goes ahead of ones made for a diff, so it's taken as close to the turn's start as it can be. */
  const slot = async <T>(fn: () => Promise<T>, first = false): Promise<T> => {
    if (running >= SNAPSHOTS_AT_ONCE) await new Promise<void>((r) => (first ? waiting.unshift(r) : waiting.push(r)))
    running++
    try {
      return await fn()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  const beginTurn = (id: string): void => {
    const a = agent(id)
    if (!a) return
    const rec = ensure(a)
    const mark = startTurn(rec, now())
    changed()
    void track(
      slot(() => d.snapshot(a.cwd), true).then(
        (snap) => {
          mark.root = snap.root
          mark.doneAt = now()
          if (snap.ok) {
            mark.tree = snap.tree
            mark.head = snap.head
            if (snap.skipped) mark.skipped = snap.skipped
          } else mark.problem = snap.problem
          changed()
        },
        (e: unknown) => {
          mark.doneAt = now()
          mark.problem = `The snapshot failed: ${String(e)}`
          changed()
        }
      )
    )
  }

  d.onStatus((id, status) => {
    if (closed) return
    const before = last.get(id)
    last.set(id, status)
    if (!agent(id)) return
    // Without a status before, this is a session Patchbay found already running, partway through whatever it was doing.
    if (status === 'working' && before !== undefined && !IN_TURN.has(before)) beginTurn(id)
    void scan(id, !IN_TURN.has(status))
    // A node exiting, or coming back, changes whose edits count as live.
    publish()
  })

  const poll = setInterval(() => {
    for (const a of d.agents()) if (IN_TURN.has(d.status(a.id))) void scan(a.id)
  }, d.pollMs ?? POLL_MS)
  poll.unref?.()

  const prune = (): void => {
    if (pruneRecords(records, new Set(d.agents().map((a) => a.id)), now()).length) changed()
    for (const id of collectors.keys()) if (!records.has(id)) collectors.delete(id)
  }
  prune()
  const pruneStore = (): void => {
    if (d.store) void track(pruneObjects(d.store.objectDir, OBJECTS_MAX_AGE_MS, OBJECTS_MAX_BYTES).catch(() => 0))
  }
  // Once things have settled, so it costs start-up nothing.
  const firstStorePrune = setTimeout(pruneStore, 60_000)
  firstStorePrune.unref?.()
  const pruner = setInterval(() => {
    prune()
    pruneStore()
  }, PRUNE_EVERY_MS)
  pruner.unref?.()

  const view = (rec: SessionRecord): SessionFiles => {
    const overlaps = findOverlaps(records.values(), live()).get(rec.nodeId) ?? {}
    return {
      nodeId: rec.nodeId,
      cwd: rec.cwd,
      files: [...rec.files].sort((a, b) => b.lastAt - a.lastAt),
      turns: rec.turns.map((t) => ({ ...t })),
      truncated: rec.truncated,
      overlaps
    }
  }

  return {
    async files(nodeId) {
      if (agent(nodeId)) await scan(nodeId, !IN_TURN.has(d.status(nodeId)))
      const rec = records.get(nodeId)
      return rec ? view(rec) : null
    },
    byTranscript(transcriptPath) {
      const key = pathKey(transcriptPath)
      for (const rec of records.values()) if (rec.transcriptPath && pathKey(rec.transcriptPath) === key) return view(rec)
      return null
    },
    async diff(nodeId, path, scope) {
      const rec = records.get(nodeId)
      if (!rec) return { ok: false, reason: 'Nothing is recorded for that session.' }
      const key = pathKey(normalizePath(rec.cwd, path))
      const file = rec.files.find((f) => pathKey(f.path) === key)
      // Only files the session touched: this is not a way to read any file.
      if (!file) return { ok: false, reason: "That file isn't one this session edited." }
      const found = diffBase(rec, file, scope)
      const base = found?.mark
      const snap = await slot(() => d.snapshot(rec.cwd))
      if (!snap.ok) return { ok: false, reason: snap.problem }
      const rel = insideRoot(snap.root, file.path)
      if (rel === null) return { ok: false, reason: `${file.path} is outside the repository at ${snap.root}.` }
      if (base && base.root && pathKey(base.root) !== pathKey(snap.root)) return { ok: false, reason: 'The session has moved to another repository since that turn.' }
      const from = base?.tree ?? snap.head ?? EMPTY_TREE
      const label = found
        ? diffLabel(found.mark, scope, found.exact)
        : snap.head
          ? 'against HEAD: no snapshot is kept from before this session first edited it'
          : 'against an empty repository'
      const out = await diffFile(d.git, snap.root, from, snap.tree, rel, d.store ? objectEnv(d.store, snap.objects) : {})
      return out.ok ? { ...out, base: label } : out
    },
    summary: () => summarize(records.values(), findOverlaps(records.values(), live())),
    scan,
    async settled() {
      while (work.size) await Promise.allSettled([...work])
    },
    flush: save,
    close() {
      closed = true
      clearTimeout(firstStorePrune)
      clearInterval(poll)
      clearInterval(pruner)
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
    }
  }
}
