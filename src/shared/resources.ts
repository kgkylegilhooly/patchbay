/** What the resource view and its warning show. Sizes are bytes, CPU is a percent of the whole PC. */

/** The PC's memory. Commit is what Windows has promised to programs, against its limit of RAM plus the page file. */
export interface SystemMemory {
  totalPhys: number
  availPhys: number
  commitLimit: number
  commitAvail: number
}

export type SessionKind = 'agent' | 'terminal' | 'run'

/** One running session and every process under it. */
export interface SessionUse {
  id: string
  title: string
  projectId: string | null
  kind: SessionKind
  status: string
  /** When it last became idle, for an agent at its prompt. Null for any other state. */
  idleSince: number | null
  /** Its process tree's private memory. Null until processes have been read. */
  memory: number | null
  cpu: number | null
  processes: number | null
}

export interface ResourceReading {
  at: number
  system: SystemMemory | null
  /** Patchbay's own processes: the main process, the window, graphics and helpers, browser pages. */
  app: { total: number; byType: Record<string, number> }
  host: { pid: number; memory: number | null } | null
  sessions: SessionUse[]
  /** When sessions' processes were last read. Null if they never have been. */
  processesAt: number | null
  /** Why they couldn't be read last time, as when Windows is out of memory to start the query. */
  processesProblem?: string
  /** Running agents, and the soft limit on them, if one is set. */
  agents: { running: number; limit: number | null }
}

export type PressureKind = 'commit' | 'physical' | 'agents'

export interface ResourceWarning {
  kind: PressureKind
  text: string
  /** Idle agents worth closing: the longest idle first, then the largest. */
  suggestions: Array<{ id: string; title: string; memory: number | null; idleSince: number | null }>
}

/** Main's resource calls, as window.patchbayResources. Served in src/main/resources/ipc.ts. */
export interface ResourcesBridge {
  /** The latest reading. `fresh` reads processes now, unless they were read moments ago. */
  get(fresh?: boolean): Promise<ResourceReading>
  /** While on, readings include processes every half minute and arrive through onReading. */
  watch(on: boolean): Promise<void>
  onReading(cb: (reading: ResourceReading) => void): () => void
  onWarning(cb: (warning: ResourceWarning) => void): () => void
  /** Main asks the window to let go of what it can: windows far off-screen are unloaded at once. */
  onLowMemory(cb: () => void): () => void
}
