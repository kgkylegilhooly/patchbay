import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { docJson } from './docJson'
import { sanitizeBoard } from '../../shared/board'
import { sanitizePrompts } from '../../shared/savedPrompts'
import { recoverTasks, sanitizeTasks } from '../../shared/task'
import { isProjectOpen, type CanvasDoc, type CanvasNode } from '../../shared/model'
import { withArchiveChecked } from './archiveCheck'
import { isWhiteboardShape, LIMITS } from '../../shared/whiteboard'
import {
  isMissingFile,
  readIfPresentSync,
  renameWithRetry,
  withLockRetry,
  withLockRetrySync,
  writeAtomic,
  writeSynced
} from './atomicFile'

const CURRENT_VERSION = 3
const FIRST_PROJECT = 'project-1'
const DEBOUNCE_MS = 500

export interface LoadResult {
  doc: CanvasDoc
  recoveredFrom: 'primary' | 'backup' | 'new'
  /** Where a bad file was moved to. The primary's, when both were bad. */
  quarantined?: string
  /** Nodes this build couldn't read, left out of the canvas. The whole file is kept at `keptAside`. */
  droppedNodes?: number
  keptAside?: string
}

export interface DocStore {
  /** Throws if a save file exists but can't be read, rather than offering an empty canvas to save over it. */
  load(): LoadResult
  save(doc: CanvasDoc): Promise<void>
  saveDebounced(doc: CanvasDoc): void
  /** Rejects if the pending doc can't be written. */
  flush(): Promise<void>
  /**
   * Writes the pending doc now, on this thread, for when there's no time to wait: Windows ending the session. Still
   * whole or not at all, and a known-good primary still becomes the backup first.
   */
  flushSync(): void
  /** Stops every later save, for good: a canvas restored from history is about to be read at the next start. */
  seal(): void
}

export interface DocStoreOptions {
  /** Called when a debounced save fails. The doc stays pending for the next flush. */
  onSaveError?: (e: unknown) => void
  /** Called after each save that went through, so a failure shown earlier can be cleared. */
  onSaved?: () => void
}

function emptyDoc(): CanvasDoc {
  const viewport = { x: 0, y: 0, zoom: 1 }
  return {
    version: CURRENT_VERSION,
    projects: [{ id: FIRST_PROJECT, name: 'My project', folder: '', viewport }],
    activeProjectId: FIRST_PROJECT,
    nodes: [],
    edges: [],
    closed: [],
    viewport
  }
}

type Fields = Record<string, unknown>

const isObject = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStringOrNull = (v: unknown) => v === null || isString(v)
const isNumberOrNull = (v: unknown) => v === null || isNumber(v)

function isSchedule(s: unknown): boolean {
  if (!isObject(s)) return false
  if (s.type === 'cron') return isString(s.expr)
  if (s.type === 'interval') return isNumber(s.everyMs)
  // Event kinds. See src/core/trigger/events.ts.
  if (s.type === 'agent') return isString(s.nodeId) && (s.on === 'turn' || s.on === 'needs-you' || s.on === 'exit')
  if (s.type === 'run') return isString(s.nodeId) && typeof s.failedOnly === 'boolean'
  if (s.type === 'files') return isString(s.folder) && isString(s.glob) && isNumber(s.quietMs)
  return s.type === 'once' && isNumber(s.at)
}

/** Optional on a trigger, so ones saved before they existed load as they were. */
function isTriggerExtras(n: Fields): boolean {
  const p = n.preflight
  const l = n.limits
  return (
    (p === undefined || p === null || (isObject(p) && Array.isArray(p.argv) && p.argv.every(isString) && isString(p.cwd))) &&
    (l === undefined || (isObject(l) && isNumber(l.gapMs) && isNumber(l.perHour))) &&
    (n.startsAt === undefined || isNumberOrNull(n.startsAt)) &&
    (n.endsAt === undefined || isNumberOrNull(n.endsAt))
  )
}

function isTriggerRun(r: unknown): boolean {
  return (
    isObject(r) &&
    isString(r.id) &&
    isNumber(r.at) &&
    (r.source === 'schedule' || r.source === 'manual' || r.source === 'event') &&
    (r.outcome === 'delivered' || r.outcome === 'queued' || r.outcome === 'missed' || r.outcome === 'failed' || r.outcome === 'skipped') &&
    (r.detail === undefined || isString(r.detail)) &&
    (r.event === undefined || isString(r.event)) &&
    (r.repeats === undefined || isNumber(r.repeats)) &&
    (r.preflight === undefined || (isObject(r.preflight) && isNumberOrNull(r.preflight.code) && isString(r.preflight.tail)))
  )
}

function isNode(n: unknown): boolean {
  if (!isObject(n)) return false
  const base =
    isString(n.id) &&
    isString(n.title) &&
    isNumber(n.x) &&
    isNumber(n.y) &&
    isNumber(n.width) &&
    isNumber(n.height) &&
    isStringOrNull(n.parentId)
  if (!base) return false
  switch (n.kind) {
    case 'terminal':
      return isString(n.cwd) && (n.sshHost === undefined || isString(n.sshHost))
    case 'claude':
      return (
        isString(n.cwd) &&
        isStringOrNull(n.sessionId) &&
        isStringOrNull(n.transcriptPath) &&
        Array.isArray(n.after) &&
        n.after.every(isString) &&
        (n.agent === undefined || n.agent === 'claude' || n.agent === 'codex')
      )
    case 'run':
      return (
        isString(n.cwd) &&
        isString(n.command) &&
        n.command.length > 0 &&
        (n.launch === undefined || (isObject(n.launch) && isString(n.launch.folder) && isString(n.launch.name))) &&
        (n.keepRunning === undefined || typeof n.keepRunning === 'boolean')
      )
    case 'sticky':
      return isString(n.text)
    case 'whiteboard':
      return Array.isArray(n.shapes) && n.shapes.length <= LIMITS.shapes && n.shapes.every(isWhiteboardShape)
    case 'trigger':
      return (
        isSchedule(n.schedule) &&
        isString(n.prompt) &&
        isStringOrNull(n.targetId) &&
        isStringOrNull(n.armedSpec) &&
        isNumberOrNull(n.armedAt) &&
        isNumberOrNull(n.nextAt) &&
        Array.isArray(n.runs) &&
        n.runs.every(isTriggerRun) &&
        isTriggerExtras(n)
      )
    case 'browser':
      return isString(n.url) && (n.held === undefined || typeof n.held === 'boolean')
    case 'file':
      return isString(n.path) && n.path.length > 0
    case 'reader':
      return isString(n.path) && (n.fromNodeId === undefined || isString(n.fromNodeId))
    case 'group':
      return (
        n.worktree === null ||
        (isObject(n.worktree) &&
          isString(n.worktree.path) &&
          isString(n.worktree.branch) &&
          isString(n.worktree.repo))
      )
    default:
      return false
  }
}

function isEdge(e: unknown): boolean {
  return (
    isObject(e) &&
    isString(e.id) &&
    isString(e.from) &&
    isString(e.to) &&
    (e.kind === 'opened' || e.kind === 'link' || e.kind === 'after')
  )
}

function isClosedSession(c: unknown): boolean {
  return (
    isObject(c) &&
    isString(c.id) &&
    isString(c.title) &&
    isString(c.cwd) &&
    isString(c.sessionId) &&
    isStringOrNull(c.transcriptPath) &&
    isNumber(c.closedAt)
  )
}

function isViewport(v: unknown): boolean {
  return isObject(v) && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom)
}

function isProject(p: unknown): boolean {
  return (
    isObject(p) &&
    isString(p.id) &&
    isString(p.name) &&
    isString(p.folder) &&
    isViewport(p.viewport) &&
    (p.closedAt === undefined || isNumber(p.closedAt))
  )
}

/** Everything from before projects becomes the first project. */
function fromVersion1(raw: Fields): Fields {
  const claim = (items: unknown): unknown =>
    Array.isArray(items) ? items.map((i) => (isObject(i) ? { ...i, projectId: FIRST_PROJECT } : i)) : items
  return {
    ...raw,
    version: 2,
    projects: [{ id: FIRST_PROJECT, name: 'My project', folder: '', viewport: raw.viewport }],
    activeProjectId: FIRST_PROJECT,
    nodes: claim(raw.nodes),
    closed: claim(raw.closed)
  }
}

/** Projects could not be closed before version 3, so every one of them comes through open. */
function fromVersion2(raw: Fields): Fields {
  return { ...raw, version: 3 }
}

/** A board is an optional extra, so a damaged one is dropped rather than refusing the whole save. */
function checkBoards(doc: CanvasDoc): CanvasDoc {
  if (!doc.projects.some((p) => p.board !== undefined)) return doc
  return {
    ...doc,
    projects: doc.projects.map((p) => {
      if (p.board === undefined) return p
      const board = sanitizeBoard(p.board)
      if (board) return { ...p, board }
      const { board: _bad, ...rest } = p
      return rest
    })
  }
}

/** The project on screen is always open, whatever a save file says. */
function showOpenProject(doc: CanvasDoc): CanvasDoc {
  const active = doc.projects.find((p) => p.id === doc.activeProjectId)
  if (!active) {
    const fallback = doc.projects.find(isProjectOpen) ?? doc.projects[0]
    return showOpenProject({ ...doc, activeProjectId: fallback.id })
  }
  if (isProjectOpen(active)) return doc
  return { ...doc, projects: doc.projects.map((p) => (p === active ? { ...p, closedAt: undefined, archivedAt: undefined } : p)) }
}

/** A node in no known project would be on no tab, looking lost while its session kept running. */
function rehomeOrphans(doc: CanvasDoc): CanvasDoc {
  const known = new Set(doc.projects.map((p) => p.id))
  const orphan = doc.nodes.some((n) => !n.projectId || !known.has(n.projectId))
  if (!orphan) return doc
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.projectId && known.has(n.projectId) ? n : ({ ...n, projectId: doc.activeProjectId } as CanvasNode)))
  }
}

/**
 * The nodes this build can read, and the cables and waits that don't lead to one it can't. One unreadable node, as
 * from a newer build after going back to an older one, used to refuse the whole file and its backup with it, so the
 * canvas opened empty. A node inside a dropped one keeps its place on the canvas, under the dropped one's own parent.
 */
function keepReadable(all: unknown[], edges: unknown[]): { nodes: unknown[]; edges: unknown[]; dropped: number } {
  const bad = all.filter((n) => !isNode(n))
  if (!bad.length) return { nodes: all, edges, dropped: 0 }
  const gone = new Map<string, Fields>()
  for (const n of bad) if (isObject(n) && isString(n.id)) gone.set(n.id, n)
  const lift = (n: Fields): Fields => {
    let parentId = n.parentId as string | null
    if (parentId === null || !gone.has(parentId)) return n
    let x = n.x as number
    let y = n.y as number
    for (let steps = 0; parentId !== null && gone.has(parentId) && steps <= gone.size; steps++) {
      const parent: Fields = gone.get(parentId)!
      x += isNumber(parent.x) ? parent.x : 0
      y += isNumber(parent.y) ? parent.y : 0
      parentId = isString(parent.parentId) ? parent.parentId : null
    }
    return { ...n, parentId: parentId !== null && gone.has(parentId) ? null : parentId, x, y }
  }
  const nodes = all.filter(isNode).map((raw) => {
    const n = lift(raw as Fields)
    return n.kind === 'claude' && (n.after as string[]).some((a) => gone.has(a)) ? { ...n, after: (n.after as string[]).filter((a) => !gone.has(a)) } : n
  })
  const linked = edges.filter((e) => !gone.has((e as Fields).from as string) && !gone.has((e as Fields).to as string))
  return { nodes, edges: linked, dropped: bad.length }
}

/** Brings saved data up to the current version. Throws if it isn't a doc this version can trust. */
export function migrate(input: unknown): CanvasDoc {
  return migrateKeeping(input).doc
}

/** migrate, saying how many nodes it had to leave out because this build can't read them. */
export function migrateKeeping(input: unknown): { doc: CanvasDoc; dropped: number } {
  if (!isObject(input)) throw new Error('Save file is not an object')
  const atTwo = input.version === 1 ? fromVersion1(input) : input
  const atThree = atTwo.version === 2 ? fromVersion2(atTwo) : atTwo
  const raw: Fields = { ...atThree, projects: withArchiveChecked(atThree.projects) }
  if (raw.version !== CURRENT_VERSION) throw new Error(`Unsupported save file version: ${String(raw.version)}`)
  if (!Array.isArray(raw.projects) || raw.projects.length === 0 || !raw.projects.every(isProject)) {
    throw new Error('Save file has invalid projects')
  }
  if (!isString(raw.activeProjectId)) throw new Error('Save file has no active project')
  if (!Array.isArray(raw.nodes)) throw new Error('Save file has no node list')
  if (!Array.isArray(raw.edges) || !raw.edges.every(isEdge)) throw new Error('Save file has invalid edges')
  if (!Array.isArray(raw.closed) || !raw.closed.every(isClosedSession)) {
    throw new Error('Save file has an invalid closed list')
  }
  if (!isViewport(raw.viewport)) throw new Error('Save file has an invalid viewport')
  const read = keepReadable(raw.nodes, raw.edges)
  if (read.dropped) console.warn(`Patchbay left out ${read.dropped} node(s) it couldn't read while loading.`)
  const doc = rehomeOrphans(showOpenProject(checkBoards({ ...withShellsChecked(raw), nodes: read.nodes, edges: read.edges } as unknown as CanvasDoc)))
  // Task data never costs the canvas: a damaged record is dropped on its own, and the rest of the project loads.
  return { doc: { ...doc, projects: doc.projects.map((p) => withPromptsChecked(withTasksChecked(p))) }, dropped: read.dropped }
}

/** Closed terminals and runs (F48) are an optional extra: an entry this build can't read is dropped on its own. */
function withShellsChecked(raw: Fields): Fields {
  if (raw.closedShells === undefined) return raw
  const { closedShells, ...rest } = raw
  if (!Array.isArray(closedShells)) return rest
  const kept = closedShells.filter((s) => isObject(s) && isNumber(s.closedAt) && isObject(s.node) && (s.node.kind === 'terminal' || s.node.kind === 'run') && isNode(s.node))
  return { ...rest, closedShells: kept }
}

/** migrateKeeping on a save file's text, or null when it isn't one this version can use. */
function parseKeeping(text: string): { doc: CanvasDoc; dropped: number } | null {
  try {
    return migrateKeeping(JSON.parse(text))
  } catch {
    return null
  }
}

/** Saved prompts (F70) are an optional extra: damaged ones are dropped on their own, never the project. */
function withPromptsChecked(p: CanvasDoc['projects'][number]): CanvasDoc['projects'][number] {
  if (p.prompts === undefined) return p
  const prompts = sanitizePrompts(p.prompts)
  if (prompts) return { ...p, prompts }
  const { prompts: _dropped, ...rest } = p
  return rest
}

function withTasksChecked(p: CanvasDoc['projects'][number]): CanvasDoc['projects'][number] {
  if (p.tasks === undefined) return p
  const clean = sanitizeTasks(p.tasks)
  if (!clean) {
    console.warn(`Patchbay dropped unreadable task data in project ${p.id} while loading.`)
    const { tasks: _dropped, ...rest } = p
    return rest
  }
  if (clean.dropped) console.warn(`Patchbay dropped ${clean.dropped} damaged task record(s) in project ${p.id} while loading.`)
  return { ...p, tasks: recoverTasks(clean.records) }
}

/** A save file's text as a canvas, or null when it isn't one this version can use. Also judges canvas history copies. */
export function parseDoc(text: string): CanvasDoc | null {
  try {
    return migrate(JSON.parse(text))
  } catch {
    return null
  }
}

interface FileStamp {
  size: number
  mtimeMs: number
}

const sameStamp = (a: FileStamp, b: FileStamp | null): boolean => b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs

function stampOf(file: string): FileStamp | null {
  try {
    const { size, mtimeMs } = statSync(file)
    return { size, mtimeMs }
  } catch {
    return null
  }
}

export function createDocStore(dir: string, options: DocStoreOptions = {}): DocStore {
  const primary = join(dir, 'canvas.json')
  const backup = join(dir, 'canvas.json.bak')
  const onSaveError = options.onSaveError ?? ((e) => console.error('Patchbay autosave failed:', e))

  let queue: Promise<unknown> = Promise.resolve()
  /** The newest doc not yet on disk. Kept as the doc, and turned into text only when it's written. */
  let pending: CanvasDoc | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /**
   * The primary as this store last wrote or loaded it, by size and time. One that still matches is known good, so it's
   * copied to the backup as it is, rather than read and checked again with every save.
   */
  let trusted: FileStamp | null = null

  /** Moves a bad file aside so that no later save can overwrite it. */
  function quarantine(file: string): string {
    const stamp = Date.now()
    let target = join(dir, `canvas.corrupt-${stamp}.json`)
    for (let n = 1; existsSync(target); n++) target = join(dir, `canvas.corrupt-${stamp}-${n}.json`)
    withLockRetrySync(() => renameSync(file, target))
    if (file === primary) trusted = null
    return target
  }

  /**
   * A file that loaded without some of its nodes is copied aside whole first: the next save writes the canvas without
   * them, and the backup follows a save later. Going back to the build that wrote them, the copy still has them.
   */
  function keptWhole(file: string, dropped: number): { droppedNodes?: number; keptAside?: string } {
    if (!dropped) return {}
    const stamp = Date.now()
    let target = join(dir, `canvas.unread-${stamp}.json`)
    for (let n = 1; existsSync(target); n++) target = join(dir, `canvas.unread-${stamp}-${n}.json`)
    withLockRetrySync(() => copyFileSync(file, target))
    return { droppedNodes: dropped, keptAside: target }
  }

  /**
   * The backup is this store's own file. Made read-only from outside (a sync tool, a restored copy), it can't be
   * replaced on Windows, and every save failed. Missing is fine: then there's nothing to replace.
   */
  const backupWritable = (): Promise<void> => chmod(backup, 0o666).catch(() => {})

  /** Copies a known-good primary to the backup by the file system alone, synced before it takes the backup's place. */
  async function copyToBackup(): Promise<void> {
    const temp = `${backup}.tmp`
    // A read-only save file copies as read-only. Left behind by a failed save, that copy blocked every later one, even
    // once the save file could be written again. So it goes first, and the copy is made writable.
    await withLockRetry(() => rm(temp, { force: true }))
    await withLockRetry(() => copyFile(primary, temp))
    await chmod(temp, 0o666)
    const handle = await open(temp, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await backupWritable()
    await renameWithRetry(temp, backup)
  }

  /** Copies the primary to the backup, leaving the primary in place in case of a crash. */
  async function rotateBackup(): Promise<void> {
    let now: FileStamp
    try {
      now = await withLockRetry(() => stat(primary))
    } catch (e) {
      if (isMissingFile(e)) return
      throw e
    }
    if (sameStamp(now, trusted)) return copyToBackup()
    let previous: string
    try {
      previous = await withLockRetry(() => readFile(primary, 'utf8'))
    } catch (e) {
      if (isMissingFile(e)) return
      throw e
    }
    // A bad primary must never replace a good backup.
    if (parseDoc(previous)) {
      await backupWritable()
      await writeAtomic(backup, previous)
    }
    else quarantine(primary)
  }

  /**
   * Saves in the order they were asked for, and the place of the last sync flush among them: a save asked for before
   * it holds an older doc, so it mustn't put that back over the newer one, however far it had got.
   */
  let asked = 0
  let flushedSyncAt = 0
  /** What the last sync flush wrote, to put back if an older save's rename, already under way, landed after it. */
  let flushedSyncDoc: CanvasDoc | null = null

  async function persist(json: string, order: number): Promise<void> {
    const temp = `${primary}.tmp`
    await writeSynced(temp, json)
    await rotateBackup()
    // Checked again before every try: a locked file means waiting, and a sync flush can write a newer doc meanwhile.
    let replaced = false
    await withLockRetry(async () => {
      if (order < flushedSyncAt) return
      await rename(temp, primary)
      replaced = true
    })
    if (!replaced) return
    trusted = await stat(primary).catch(() => null)
    // A rename already handed to the file system can't be called back, so a sync flush during it may now lie under
    // this older doc. Whichever landed last, writing the flushed doc again leaves the newest on top.
    if (order < flushedSyncAt && flushedSyncDoc) await persist(docJson(flushedSyncDoc), flushedSyncAt)
  }

  /** Set by seal(): nothing is written after it. */
  let sealed = false

  function enqueue(doc: CanvasDoc): Promise<void> {
    if (sealed) return Promise.resolve()
    const order = ++asked
    const run = queue.then(async () => {
      if (order < flushedSyncAt) return
      // Turned into text here, once, however many changes came while it waited.
      await persist(docJson(doc), order)
      if (pending === doc) pending = null
      options.onSaved?.()
    })
    queue = run.catch(() => {})
    return run
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    load() {
      const primaryText = readIfPresentSync(primary)
      const primaryRead = primaryText === null ? null : parseKeeping(primaryText)
      if (primaryRead) {
        trusted = stampOf(primary)
        return { doc: primaryRead.doc, recoveredFrom: 'primary', ...keptWhole(primary, primaryRead.dropped) }
      }
      const badPrimary = primaryText === null ? undefined : quarantine(primary)

      const backupText = readIfPresentSync(backup)
      const backupRead = backupText === null ? null : parseKeeping(backupText)
      const quarantined = badPrimary ? { quarantined: badPrimary } : {}
      if (backupRead) return { doc: backupRead.doc, recoveredFrom: 'backup', ...quarantined, ...keptWhole(backup, backupRead.dropped) }
      const badBackup = backupText === null ? undefined : quarantine(backup)

      const firstBad = badPrimary ?? badBackup
      return { doc: emptyDoc(), recoveredFrom: 'new', ...(firstBad ? { quarantined: firstBad } : {}) }
    },

    save(doc) {
      clearTimer()
      pending = null
      return enqueue(doc)
    },

    // The timer isn't reset by later calls, so nonstop changes such as a long drag can't starve autosave.
    // Only the doc is held until then: turning a big canvas into text took 60 ms, with every change.
    saveDebounced(doc) {
      if (sealed) return
      pending = doc
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (pending !== null) enqueue(pending).catch(onSaveError)
      }, DEBOUNCE_MS)
    },

    async flush() {
      clearTimer()
      await queue
      clearTimer()
      if (pending !== null) await enqueue(pending)
    },

    seal() {
      sealed = true
      clearTimer()
      pending = null
    },

    flushSync() {
      if (sealed) return
      clearTimer()
      if (pending === null) return
      const doc = pending
      flushedSyncAt = ++asked
      flushedSyncDoc = doc
      // Temp names of its own, so a save already under way can't write into the same file.
      // As in a save: a copy of a read-only file is read-only too, and one left behind blocked every later flush, so
      // it goes first and the copy is made writable; a backup made read-only from outside is made writable again.
      const replace = (target: string, fill: (temp: string) => void): void => {
        const temp = `${target}.now.tmp`
        withLockRetrySync(() => rmSync(temp, { force: true }))
        fill(temp)
        chmodSync(temp, 0o666)
        const fd = openSync(temp, 'r+')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        if (target === backup) {
          try {
            chmodSync(backup, 0o666)
          } catch {}
        }
        withLockRetrySync(() => renameSync(temp, target))
      }
      const now = stampOf(primary)
      if (now && sameStamp(now, trusted)) replace(backup, (temp) => copyFileSync(primary, temp))
      replace(primary, (temp) => writeFileSync(temp, docJson(doc)))
      if (pending === doc) pending = null
      trusted = stampOf(primary)
    }
  }
}
