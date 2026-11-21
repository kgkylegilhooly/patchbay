import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { parseAgentLimit } from '../../core/resources/agentLimit'
import { PROCESS_QUERY } from '../../core/resources/processes'
import type { CanvasStore } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import type { SystemMemory } from '../../shared/resources'
import type { Settings } from '../../shared/settings'
import { createResourceMonitor, PROCESS_TIMEOUT_MS, systemMemoryFrom, type ResourceMonitor, type SessionInfo } from './monitor'

const listProcesses = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY], { windowsHide: true, timeout: PROCESS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    )
  })

/**
 * Made-up readings for pictures of the view (screenshot.js scenes): `fake-resources.json` in the profile, read only by a
 * build run from source. The PC's memory, and each session's memory and CPU by node id, in place of the real ones.
 */
interface FakeReadings {
  system?: SystemMemory
  sessions?: Record<string, { memory: number; cpu?: number; processes?: number }>
  /** The session host's own process. */
  host?: { memory: number }
}

function readFake(dataDir: string): FakeReadings | null {
  if (app.isPackaged) return null
  try {
    return JSON.parse(readFileSync(join(dataDir, 'fake-resources.json'), 'utf8')) as FakeReadings
  } catch {
    return null
  }
}

/** Process rows for the made-up readings, with each session's real root process, so its tree is found as usual. */
function fakeProcesses(fake: FakeReadings, sessions: () => SessionInfo[], hostPid: () => number | null, cores: number): () => Promise<string> {
  const cpuMs = new Map<number, number>()
  let last = Date.now()
  return async () => {
    const now = Date.now()
    const rows = sessions().flatMap((s) => {
      const f = s.pid ? fake.sessions?.[s.id] : undefined
      if (!f || !s.pid) return []
      const pid = s.pid
      cpuMs.set(pid, (cpuMs.get(pid) ?? 0) + ((f.cpu ?? 0) / 100) * cores * (now - last))
      return [{ ProcessId: pid, ParentProcessId: 0, Name: 'claude.exe', PrivatePageCount: f.memory, KernelModeTime: 0, UserModeTime: Math.round((cpuMs.get(pid) ?? 0) * 10_000) }]
    })
    last = now
    const host = hostPid()
    if (host && fake.host) rows.push({ ProcessId: host, ParentProcessId: 0, Name: 'Patchbay Host.exe', PrivatePageCount: fake.host.memory, KernelModeTime: 0, UserModeTime: 0 })
    return JSON.stringify(rows)
  }
}

/**
 * The resource view and its warning. Every half minute it reads Patchbay's own processes and the PC's memory, which
 * starts no program. Sessions' process trees take one PowerShell query, made only while the view is open or a warning
 * is about to show. Served to the app's own window only, on `pb:resources:*`. See src/preload/resources.ts.
 */
export function setupResources(d: {
  dataDir: string
  store: CanvasStore
  host: { pid(id: string): number | null; isRunning(id: string): boolean }
  /** Every session the host runs, with or without a node. */
  hosted?(): Array<{ id: string; pid: number | null; running: boolean }>
  hostPid(): number | null
  tracker: { get(id: string): AgentStatus; since(id: string): { at: number } | undefined }
  settings(): Settings
  broadcast(channel: string, ...args: unknown[]): void
  isAppUi(e: IpcMainInvokeEvent): boolean
}): ResourceMonitor {
  const sessions = (): SessionInfo[] => {
    const nodes = d.store.get().nodes
    const onCanvas = nodes.flatMap((n): SessionInfo[] => {
      if (n.kind !== 'claude' && n.kind !== 'terminal' && n.kind !== 'run') return []
      if (!d.host.isRunning(n.id)) return []
      const status = d.tracker.get(n.id)
      return [
        {
          id: n.id,
          title: n.title,
          projectId: n.projectId ?? null,
          kind: n.kind === 'claude' ? 'agent' : n.kind,
          pid: d.host.pid(n.id),
          status,
          idleSince: n.kind === 'claude' && status === 'idle' ? (d.tracker.since(n.id)?.at ?? null) : null
        }
      ]
    })
    // Sessions the host runs that no node shows: they hold memory too, and it's why one would be ended.
    const known = new Set(nodes.map((n) => n.id))
    const unseen = (d.hosted?.() ?? [])
      .filter((s) => s.running && !known.has(s.id))
      .map((s): SessionInfo => ({ id: s.id, title: '', projectId: null, kind: 'unknown', pid: s.pid, status: 'unknown', idleSince: null }))
    return [...onCanvas, ...unseen]
  }

  const cores = cpus().length || 1
  const fake = readFake(d.dataDir)
  const monitor = createResourceMonitor({
    appMetrics: () => app.getAppMetrics(),
    systemMemory: () => fake?.system ?? systemMemoryFrom(process.getSystemMemoryInfo()),
    listProcesses: fake?.sessions ? fakeProcesses(fake, sessions, d.hostPid, cores) : listProcesses,
    sessions,
    hostPid: d.hostPid,
    agentLimit: () => parseAgentLimit(d.settings().agentLimit),
    cores,
    onReading: (r) => d.broadcast('pb:resources:reading', r),
    onWarning: (w) => d.broadcast('pb:resources:warning', w),
    onLow: () => d.broadcast('pb:resources:low')
  })

  const watching = new Set<number>()
  ipcMain.handle('pb:resources:get', async (e, fresh: unknown) => {
    if (!d.isAppUi(e)) return null
    return fresh === true ? monitor.tick({ processes: true }) : monitor.reading()
  })
  ipcMain.handle('pb:resources:watch', (e, on: unknown) => {
    if (!d.isAppUi(e)) return
    const id = e.sender.id
    if (on === true && !watching.has(id)) {
      watching.add(id)
      monitor.watch(true)
      // A window that reloads or closes stops watching with it.
      e.sender.once('destroyed', () => {
        if (watching.delete(id)) monitor.watch(false)
      })
    } else if (on !== true && watching.delete(id)) monitor.watch(false)
  })
  const stop = monitor.start()
  app.on('will-quit', stop)
  return monitor
}
