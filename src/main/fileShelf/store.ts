import { existsSync, renameSync } from 'node:fs'
import { readIfPresentSync, withLockRetrySync, writeAtomic } from '../../core/persist/atomicFile'
import { forgetEntry, isShelfEntry, noteEntry, SHELF_LIMIT, type ShelfEntry } from '../../shared/fileShelf'

const WRITE_DELAY_MS = 500

/**
 * Every project's Files shelf: references to files shared in it, newest first. Kept in `file-shelf.json` in app data.
 *
 * Other features add to it with `note`: the doc viewer as `source: 'doc'`, and files-touched as `source: 'touched'`.
 */
export class FileShelfStore {
  /** Why the saved shelf couldn't be read, if it couldn't. It then starts empty. */
  loadProblem: string | null = null
  private projects = new Map<string, ShelfEntry[]>()
  private listeners = new Set<(projectId: string) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private file: string,
    private opts: { limit?: number; writeDelayMs?: number; log?: (line: string) => void } = {}
  ) {
    this.load()
  }

  private load(): void {
    let text: string | null
    try {
      text = readIfPresentSync(this.file)
    } catch (e) {
      this.loadProblem = `The Files shelf couldn't be read: ${(e as Error).message}`
      return
    }
    if (text === null) return
    try {
      const raw = JSON.parse(text) as { projects?: Record<string, unknown> }
      for (const [id, list] of Object.entries(raw.projects ?? {})) {
        if (!Array.isArray(list)) continue
        const entries = list.filter(isShelfEntry).sort((a, b) => b.at - a.at).slice(0, this.limit)
        if (entries.length) this.projects.set(id, entries)
      }
    } catch (e) {
      // Moved aside first, so the next change can't write over what was in it (FS1).
      const kept = this.setAside()
      this.loadProblem = `The Files shelf couldn't be read, so it starts empty: ${(e as Error).message}${kept ? ` The file was kept at ${kept}.` : ''}`
    }
  }

  /** Renames the unreadable file beside itself, as the canvas's corrupt copies are. Null if it couldn't be moved. */
  private setAside(): string | null {
    const stamp = Date.now()
    const base = this.file.replace(/\.json$/i, '')
    let target = `${base}.corrupt-${stamp}.json`
    for (let n = 1; existsSync(target); n++) target = `${base}.corrupt-${stamp}-${n}.json`
    try {
      withLockRetrySync(() => renameSync(this.file, target))
      return target
    } catch (e) {
      this.opts.log?.(`The unreadable Files shelf couldn't be moved aside: ${(e as Error).message}`)
      return null
    }
  }

  private get limit(): number {
    return this.opts.limit ?? SHELF_LIMIT
  }

  list(projectId: string): ShelfEntry[] {
    return this.projects.get(projectId) ?? []
  }

  note(projectId: string, entry: ShelfEntry): void {
    if (!projectId || !isShelfEntry(entry)) return
    this.projects.set(projectId, noteEntry(this.list(projectId), entry, this.limit))
    this.changed(projectId)
  }

  forget(projectId: string, path: string): void {
    const before = this.list(projectId)
    const after = forgetEntry(before, path)
    if (after.length === before.length) return
    if (after.length) this.projects.set(projectId, after)
    else this.projects.delete(projectId)
    this.changed(projectId)
  }

  /** Drops the shelves of projects that no longer exist. */
  keepOnly(projectIds: Iterable<string>): void {
    const keep = new Set(projectIds)
    for (const id of [...this.projects.keys()]) {
      if (keep.has(id)) continue
      this.projects.delete(id)
      this.changed(id)
    }
  }

  onChange(cb: (projectId: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Writes now, as at quit. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.write()
    }
    return this.writing
  }

  private changed(projectId: string): void {
    for (const cb of this.listeners) cb(projectId)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, this.opts.writeDelayMs ?? WRITE_DELAY_MS)
    this.timer.unref?.()
  }

  private write(): void {
    const text = JSON.stringify({ version: 1, projects: Object.fromEntries(this.projects) })
    this.writing = this.writing
      .then(() => writeAtomic(this.file, text))
      .catch((e: unknown) => this.opts.log?.(`The Files shelf couldn't be saved: ${(e as Error).message}`))
  }
}
