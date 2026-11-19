import { existsSync, renameSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeBoard } from '../../shared/board'
import { recoverTasks, sanitizeTasks } from '../../shared/task'
import { isProjectOpen, type CanvasDoc, type CanvasNode } from '../../shared/model'
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
}

export interface DocStore {
  /** Throws if a save file exists but can't be read, rather than offering an empty canvas to save over it. */
  load(): LoadResult
  save(doc: CanvasDoc): Promise<void>
  saveDebounced(doc: CanvasDoc): void
  /** Rejects if the pending doc can't be written. */
  flush(): Promise<void>
}

export interface DocStoreOptions {
  /** Called when a debounced save fails. The doc stays pending for the next flush. */
  onSaveError?: (e: unknown) => void
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
  return s.type === 'once' && isNumber(s.at)
}

function isTriggerRun(r: unknown): boolean {
  return (
    isObject(r) &&
    isString(r.id) &&
    isNumber(r.at) &&
    (r.source === 'schedule' || r.source === 'manual') &&
    (r.outcome === 'delivered' || r.outcome === 'queued' || r.outcome === 'missed' || r.outcome === 'failed') &&
    (r.detail === undefined || isString(r.detail))
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
        (n.launch === undefined || (isObject(n.launch) && isString(n.launch.folder) && isString(n.launch.name)))
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
        n.runs.every(isTriggerRun)
      )
    case 'browser':
      return isString(n.url) && (n.held === undefined || typeof n.held === 'boolean')
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
  return { ...doc, projects: doc.projects.map((p) => (p === active ? { ...p, closedAt: undefined } : p)) }
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

/** Brings saved data up to the current version. Throws if it isn't a doc this version can trust. */
export function migrate(input: unknown): CanvasDoc {
  if (!isObject(input)) throw new Error('Save file is not an object')
  const atTwo = input.version === 1 ? fromVersion1(input) : input
  const raw = atTwo.version === 2 ? fromVersion2(atTwo) : atTwo
  if (raw.version !== CURRENT_VERSION) throw new Error(`Unsupported save file version: ${String(raw.version)}`)
  if (!Array.isArray(raw.projects) || raw.projects.length === 0 || !raw.projects.every(isProject)) {
    throw new Error('Save file has invalid projects')
  }
  if (!isString(raw.activeProjectId)) throw new Error('Save file has no active project')
  if (!Array.isArray(raw.nodes) || !raw.nodes.every(isNode)) throw new Error('Save file has invalid nodes')
  if (!Array.isArray(raw.edges) || !raw.edges.every(isEdge)) throw new Error('Save file has invalid edges')
  if (!Array.isArray(raw.closed) || !raw.closed.every(isClosedSession)) {
    throw new Error('Save file has an invalid closed list')
  }
  if (!isViewport(raw.viewport)) throw new Error('Save file has an invalid viewport')
  const doc = rehomeOrphans(showOpenProject(checkBoards(raw as unknown as CanvasDoc)))
  // Task data never costs the canvas: a damaged record is dropped on its own, and the rest of the project loads.
  return { ...doc, projects: doc.projects.map(withTasksChecked) }
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

function parseDoc(text: string): CanvasDoc | null {
  try {
    return migrate(JSON.parse(text))
  } catch {
    return null
  }
}

export function createDocStore(dir: string, options: DocStoreOptions = {}): DocStore {
  const primary = join(dir, 'canvas.json')
  const backup = join(dir, 'canvas.json.bak')
  const onSaveError = options.onSaveError ?? ((e) => console.error('Patchbay autosave failed:', e))

  let queue: Promise<unknown> = Promise.resolve()
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  /** Moves a bad file aside so that no later save can overwrite it. */
  function quarantine(file: string): string {
    const stamp = Date.now()
    let target = join(dir, `canvas.corrupt-${stamp}.json`)
    for (let n = 1; existsSync(target); n++) target = join(dir, `canvas.corrupt-${stamp}-${n}.json`)
    withLockRetrySync(() => renameSync(file, target))
    return target
  }

  /** Copies the primary to the backup, leaving the primary in place in case of a crash. */
  async function rotateBackup(): Promise<void> {
    let previous: string
    try {
      previous = await withLockRetry(() => readFile(primary, 'utf8'))
    } catch (e) {
      if (isMissingFile(e)) return
      throw e
    }
    // A bad primary must never replace a good backup.
    if (parseDoc(previous)) await writeAtomic(backup, previous)
    else quarantine(primary)
  }

  async function persist(json: string): Promise<void> {
    const temp = `${primary}.tmp`
    await writeSynced(temp, json)
    await rotateBackup()
    await renameWithRetry(temp, primary)
  }

  function enqueue(json: string): Promise<void> {
    const run = queue.then(async () => {
      await persist(json)
      if (pending === json) pending = null
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
      const primaryDoc = primaryText === null ? null : parseDoc(primaryText)
      if (primaryDoc) return { doc: primaryDoc, recoveredFrom: 'primary' }
      const badPrimary = primaryText === null ? undefined : quarantine(primary)

      const backupText = readIfPresentSync(backup)
      const backupDoc = backupText === null ? null : parseDoc(backupText)
      const quarantined = badPrimary ? { quarantined: badPrimary } : {}
      if (backupDoc) return { doc: backupDoc, recoveredFrom: 'backup', ...quarantined }
      const badBackup = backupText === null ? undefined : quarantine(backup)

      const firstBad = badPrimary ?? badBackup
      return { doc: emptyDoc(), recoveredFrom: 'new', ...(firstBad ? { quarantined: firstBad } : {}) }
    },

    save(doc) {
      clearTimer()
      pending = null
      return enqueue(JSON.stringify(doc))
    },

    // The timer isn't reset by later calls, so nonstop changes such as a long drag can't starve autosave.
    saveDebounced(doc) {
      pending = JSON.stringify(doc)
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
    }
  }
}
