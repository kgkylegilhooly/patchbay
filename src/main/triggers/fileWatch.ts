import { watch } from 'node:fs'
import { ignoredPath, matchesGlob, MAX_FILES_LISTED } from '../../core/trigger/events'

export interface FolderWatcher {
  close(): void
}

/** Calls `onChange` with each changed path, relative to the folder. Throws if the folder can't be watched. */
export type WatchFolder = (folder: string, onChange: (rel: string) => void, onError: (e: Error) => void) => FolderWatcher

/**
 * The whole folder, below it too. On Windows and macOS this is one watch the system keeps; paths under .git and
 * node_modules still arrive, and are dropped by the batcher.
 */
export const watchFolder: WatchFolder = (folder, onChange, onError) => {
  const w = watch(folder, { recursive: true, persistent: false }, (_type, name) => {
    if (name) onChange(String(name))
  })
  w.on('error', onError)
  return { close: () => w.close() }
}

export interface FileBatch {
  /** The first few, in the order they first changed. */
  files: string[]
  total: number
  firstAt: number
  lastAt: number
}

/** Paths kept to count. Past this the count stops growing, which nobody needs exactly. */
const MAX_TRACKED = 1000

/**
 * Gathers changes that match the glob until `quietMs` passes with none, then hands them over as one batch, so a save
 * of twenty files or a build's burst of writes fires once.
 */
export function createFileBatcher({ glob, quietMs, now, onBatch }: { glob: string; quietMs: number; now: () => number; onBatch: (b: FileBatch) => void }) {
  let changed = new Set<string>()
  let firstAt = 0
  let lastAt = 0
  let timer: NodeJS.Timeout | null = null

  const flush = (): void => {
    timer = null
    if (!changed.size) return
    const files = [...changed]
    const batch = { files: files.slice(0, MAX_FILES_LISTED), total: files.length, firstAt, lastAt }
    changed = new Set()
    onBatch(batch)
  }

  return {
    change(rel: string): void {
      const path = rel.replace(/\\/g, '/')
      if (ignoredPath(path) || !matchesGlob(path, glob)) return
      const t = now()
      if (!changed.size) firstAt = t
      lastAt = t
      if (changed.size < MAX_TRACKED) changed.add(path)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, quietMs)
      timer.unref?.()
    },
    close(): void {
      if (timer) clearTimeout(timer)
      timer = null
      changed = new Set()
    }
  }
}
