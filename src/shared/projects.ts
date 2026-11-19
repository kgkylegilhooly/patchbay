/** What the projects manager and the archive confirmation ask main. Served in src/main/projects/ipc.ts. */

export interface ArchiveSession {
  id: string
  title: string
  kind: 'claude' | 'terminal' | 'run'
  running: boolean
  /** An agent with a saved conversation, which resumes when started again. */
  resumable: boolean
}

export interface ArchiveSite {
  origin: string
  /** Whose browser store it's in: pages the person opened, or pages agents opened. */
  store: 'person' | 'agent'
  /** Other projects that aren't archived and show this site from the same store. A shared site is left alone. */
  sharedWith: string[]
}

export type ArchivePreview =
  | {
      ok: true
      projectId: string
      name: string
      sessions: ArchiveSession[]
      browsers: Array<{ id: string; title: string; url: string }>
      /** Armed triggers, which archiving disarms. */
      triggers: Array<{ id: string; title: string }>
      kept: {
        notes: number
        whiteboards: number
        groups: number
        board: boolean
      }
      /** What "also clear saved terminal output" frees. */
      scrollbackBytes: number
      sites: ArchiveSite[]
    }
  | { ok: false; reason: string }

export interface ArchiveOptions {
  clearScrollback: boolean
  clearSites: boolean
}

export type ArchiveResult =
  | {
      ok: true
      stopped: number
      /** Sessions still running after the stop, by title. */
      stillRunning: string[]
      freedBytes: number
      clearedSites: string[]
      keptSites: string[]
      /** A clear that failed after the archive itself had happened. */
      problem?: string
    }
  | { ok: false; reason: string }

export interface ProjectStats {
  id: string
  /** Saved terminal and run output, on disk. */
  scrollbackBytes: number
  /** Sessions running now. */
  running: number
  /** The newest sign of use: on screen now, a session's output or conversation, closing it. Null if there's none. */
  lastActiveAt: number | null
}

export interface StorageReport {
  projects: ProjectStats[]
  /** Browser data, shared by every project. */
  browser: { personBytes: number; agentBytes: number; cacheBytes: number }
}

export interface ProjectsBridge {
  storage(): Promise<StorageReport>
  previewArchive(id: string): Promise<ArchivePreview>
  archive(id: string, options: ArchiveOptions): Promise<ArchiveResult>
  /** The HTTP and code caches of both browser stores. Sign-ins and site data stay. Returns the bytes freed. */
  clearBrowserCache(): Promise<{ ok: true; freedBytes: number } | { ok: false; reason: string }>
}

export const PROJECTS_BRIDGE_METHODS: (keyof ProjectsBridge)[] = ['storage', 'previewArchive', 'archive', 'clearBrowserCache']

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
