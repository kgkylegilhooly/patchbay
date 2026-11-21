import { buildWarning, noteCleared, pressureNow, shouldWarn, type WarnedAt } from '../../core/resources/pressure'
import { cpuPercent, parseProcessRows, treeUse } from '../../core/resources/processes'
import type { PressureKind, ResourceReading, ResourceWarning, SessionKind, SessionUse, SystemMemory } from '../../shared/resources'

/** Cheap readings (Patchbay's own processes and the PC's memory) are taken this often. They start no program. */
export const TICK_MS = 30_000
export const FIRST_TICK_MS = 5_000
/** Sessions' processes are read with one PowerShell query, never more often than this. */
export const PROCESS_MIN_GAP_MS = 25_000
/** A query that hasn't answered by then is given up on. */
export const PROCESS_TIMEOUT_MS = 20_000
/** Asked for by hand, as by Refresh, they're still read at most this often. */
export const PROCESS_ASKED_GAP_MS = 3_000
export const COMMIT_SPARED = "Processes aren't read by themselves while Windows is nearly out of memory to give programs, since reading them takes some. Refresh reads them now."

export interface SessionInfo {
  id: string
  title: string
  projectId: string | null
  kind: SessionKind
  /** The session's root process, or null if it isn't running. */
  pid: number | null
  status: string
  idleSince: number | null
}

export interface ResourceMonitorDeps {
  /** Patchbay's own processes, by type: Electron's app.getAppMetrics, private bytes in KB. */
  appMetrics(): Array<{ type: string; memory?: { privateBytes?: number; workingSetSize: number } }>
  systemMemory(): SystemMemory | null
  /** The process query's JSON. Rejects if PowerShell can't start, as when Windows is out of commit. */
  listProcesses(): Promise<string>
  sessions(): SessionInfo[]
  hostPid(): number | null
  agentLimit(): number | null
  cores: number
  now?: () => number
  onReading?(reading: ResourceReading): void
  onWarning?(warning: ResourceWarning): void
  /** Memory has just run short. */
  onLow?(kind: PressureKind): void
}

export interface ResourceMonitor {
  reading(): ResourceReading
  /** Takes the cheap readings and, when they're due and wanted, sessions' processes. */
  tick(opts?: { processes?: boolean }): Promise<ResourceReading>
  watch(on: boolean): void
  start(): () => void
}

/** Electron's reading of the PC's memory, in KB. On Windows "swap" is the commit limit and what's left of it. */
export function systemMemoryFrom(info: { total: number; free: number; swapTotal?: number; swapFree?: number }): SystemMemory | null {
  if (!(info.total > 0)) return null
  const k = (n: number | undefined): number => Math.max(0, Math.round((n ?? 0) * 1024))
  return { totalPhys: k(info.total), availPhys: k(info.free), commitLimit: k(info.swapTotal), commitAvail: k(info.swapFree) }
}

const kb = (n: number | undefined): number => Math.max(0, Math.round((n ?? 0) * 1024))

export function createResourceMonitor(d: ResourceMonitorDeps): ResourceMonitor {
  const now = d.now ?? Date.now
  let watchers = 0
  let processesAt: number | null = null
  let processesProblem: string | undefined
  let reading: ResourceReading | null = null
  let inFlight: Promise<void> | null = null
  /** The last query's processes, by pid: CPU time, and the tree each session had. */
  let cpuBefore: Map<number, number> | null = null
  let cpuBeforeAt = 0
  let perSession = new Map<string, { memory: number; cpu: number | null; processes: number }>()
  let hostMemory: number | null = null
  const warned: WarnedAt = {}
  let lastKind: PressureKind | null = null

  const readProcesses = async (): Promise<void> => {
    const sessions = d.sessions()
    const roots = new Map<number, string>()
    for (const s of sessions) if (s.pid) roots.set(s.pid, s.id)
    const hostPid = d.hostPid()
    if (hostPid) roots.set(hostPid, '\0host')
    let text: string
    try {
      text = await d.listProcesses()
    } catch (e) {
      processesProblem = `Couldn't read processes: ${e instanceof Error ? e.message : String(e)}`
      return
    }
    const at = now()
    const rows = parseProcessRows(text)
    if (!rows.length) {
      processesProblem = "Couldn't read processes: the answer was empty."
      return
    }
    const cpuNow = new Map(rows.map((r) => [r.pid, r.cpuMs]))
    const trees = treeUse(rows, roots)
    // The host's own process only: its sessions are counted under each session.
    hostMemory = hostPid ? (rows.find((r) => r.pid === hostPid)?.memory ?? null) : null
    trees.delete('\0host')
    perSession = new Map(
      [...trees].map(([id, t]) => [id, { memory: t.memory, cpu: cpuPercent(t.pids, cpuNow, cpuBefore, at - cpuBeforeAt, d.cores), processes: t.pids.length }])
    )
    cpuBefore = cpuNow
    cpuBeforeAt = at
    processesAt = at
    processesProblem = undefined
  }

  const ensureProcesses = (force: boolean): Promise<void> => {
    if (inFlight) return inFlight
    if (processesAt !== null && now() - processesAt < (force ? PROCESS_ASKED_GAP_MS : PROCESS_MIN_GAP_MS)) return Promise.resolve()
    if (!d.sessions().some((s) => s.pid) && !force) return Promise.resolve()
    inFlight = readProcesses().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const build = (): ResourceReading => {
    const byType: Record<string, number> = {}
    let total = 0
    for (const m of d.appMetrics()) {
      const bytes = kb(m.memory?.privateBytes ?? m.memory?.workingSetSize)
      byType[m.type] = (byType[m.type] ?? 0) + bytes
      total += bytes
    }
    const sessions: SessionUse[] = d.sessions()
      .filter((s) => s.pid)
      .map((s) => {
        const use = perSession.get(s.id)
        return { id: s.id, title: s.title, projectId: s.projectId, kind: s.kind, status: s.status, idleSince: s.idleSince, memory: use?.memory ?? null, cpu: use?.cpu ?? null, processes: use?.processes ?? null }
      })
      .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))
    const hostPid = d.hostPid()
    const limit = d.agentLimit()
    return {
      at: now(),
      system: d.systemMemory(),
      app: { total, byType },
      host: hostPid ? { pid: hostPid, memory: hostMemory } : null,
      sessions,
      processesAt,
      ...(processesProblem ? { processesProblem } : {}),
      agents: { running: sessions.filter((s) => s.kind === 'agent').length, limit }
    }
  }

  const tick = async (opts: { processes?: boolean } = {}): Promise<ResourceReading> => {
    let next = build()
    const kind = pressureNow(next.system, next.agents)
    const memoryShort = kind === 'commit' || kind === 'physical'
    if (memoryShort && lastKind !== kind) d.onLow?.(kind)
    lastKind = kind
    noteCleared(warned, kind)
    const warn = shouldWarn(kind, warned, now())
    // PowerShell takes ~80 MB of commit, which an agent's next command may need when commit is what's short. Then only
    // Refresh reads processes, and a warning names idle agents from the last reading, or by idle time alone.
    const spare = kind === 'commit'
    if (opts.processes || (!spare && (watchers > 0 || warn))) {
      await ensureProcesses(!!opts.processes)
      next = build()
    } else if (spare && watchers > 0 && !next.processesProblem) {
      next = { ...next, processesProblem: COMMIT_SPARED }
    }
    reading = next
    if (warn && kind) {
      warned[kind] = { at: now(), cleared: false }
      d.onWarning?.(buildWarning(kind, next.system, next.agents, next.sessions))
    }
    if (watchers > 0) d.onReading?.(next)
    return next
  }

  return {
    reading: () => reading ?? build(),
    tick,
    watch(on) {
      watchers = Math.max(0, watchers + (on ? 1 : -1))
      if (on) void tick()
    },
    start() {
      // A first look soon after launch, so memory already short is said without waiting for the first interval.
      const first = setTimeout(() => void tick().catch(() => {}), FIRST_TICK_MS)
      const timer = setInterval(() => void tick().catch(() => {}), TICK_MS)
      first.unref?.()
      timer.unref?.()
      return () => {
        clearTimeout(first)
        clearInterval(timer)
      }
    }
  }
}
