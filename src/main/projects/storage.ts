import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isSessionNode, type CanvasDoc } from '../../shared/model'
import type { ProjectStats } from '../../shared/projects'

export interface FileInfo {
  size: number
  mtimeMs: number
}

/** A file's size and when it last changed, or null if it isn't there. */
export async function fileInfo(path: string): Promise<FileInfo | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null
  } catch {
    return null
  }
}

/** Everything under a folder, in bytes. What can't be read counts as nothing. */
export async function folderBytes(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  const sizes = await Promise.all(
    entries.map(async (e) => {
      const path = join(dir, e.name)
      if (e.isDirectory()) return folderBytes(path)
      if (!e.isFile()) return 0
      return (await fileInfo(path))?.size ?? 0
    })
  )
  return sizes.reduce((a, b) => a + b, 0)
}

/**
 * Per project: its saved output on disk, what runs, and when it was last used. Nothing new is stored for this; it's
 * read from what's already there each time the manager asks.
 */
export async function measureProjects(
  doc: CanvasDoc,
  io: {
    scrollback(id: string): Promise<FileInfo | null>
    transcript(path: string): Promise<FileInfo | null>
    isRunning(id: string): boolean
    now: number
  }
): Promise<ProjectStats[]> {
  return Promise.all(
    doc.projects.map(async (p): Promise<ProjectStats> => {
      const sessions = doc.nodes.filter((n) => n.projectId === p.id).filter(isSessionNode)
      const times: number[] = []
      if (p.id === doc.activeProjectId) times.push(io.now)
      if (p.closedAt !== undefined) times.push(p.closedAt)
      if (p.archivedAt !== undefined) times.push(p.archivedAt)
      for (const c of doc.closed) if (c.projectId === p.id) times.push(c.closedAt)
      let scrollbackBytes = 0
      await Promise.all(
        sessions.map(async (n) => {
          const saved = await io.scrollback(n.id)
          if (saved) {
            scrollbackBytes += saved.size
            times.push(saved.mtimeMs)
          }
          if (n.kind === 'claude' && n.transcriptPath) {
            const t = await io.transcript(n.transcriptPath)
            if (t) times.push(t.mtimeMs)
          }
        })
      )
      return {
        id: p.id,
        scrollbackBytes,
        running: sessions.filter((n) => io.isRunning(n.id)).length,
        lastActiveAt: times.length ? Math.round(Math.max(...times)) : null
      }
    })
  )
}
