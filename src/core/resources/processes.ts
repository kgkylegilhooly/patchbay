/** Every process on the PC, read in one query, and what each session's tree of them uses. Pure, so it's tested alone. */

export interface ProcessRow {
  pid: number
  parent: number
  name: string
  /** Private bytes: the memory Windows has committed to it. */
  memory: number
  /** Kernel and user time together. */
  cpuMs: number
  /** When it started, in ms since 1970. 0 if unknown. */
  started: number
}

/**
 * One PowerShell call for every process. CIM gives CPU times in 100 ns units and a start time PowerShell 5 writes as
 * "/Date(ms)/". Select-Object keeps the answer small.
 */
export const PROCESS_QUERY =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,PrivatePageCount,KernelModeTime,UserModeTime,CreationDate | Select-Object ProcessId,ParentProcessId,Name,PrivatePageCount,KernelModeTime,UserModeTime,CreationDate | ConvertTo-Json -Compress'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0)

function startedAt(v: unknown): number {
  if (typeof v === 'string') {
    const ms = /\/Date\((\d+)/.exec(v)
    if (ms) return Number(ms[1])
    const parsed = Date.parse(v)
    return Number.isFinite(parsed) ? parsed : 0
  }
  // PowerShell 7 writes a date as an object with the time in it.
  if (v && typeof v === 'object' && 'value' in v) return startedAt((v as { value: unknown }).value)
  return 0
}

/** The query's JSON. Anything that isn't a process is skipped, and a damaged answer is no processes. */
export function parseProcessRows(json: string): ProcessRow[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const rows: ProcessRow[] = []
  for (const p of (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>) {
    if (!p || typeof p.ProcessId !== 'number') continue
    rows.push({
      pid: p.ProcessId,
      parent: num(p.ParentProcessId),
      name: typeof p.Name === 'string' ? p.Name : '',
      memory: num(p.PrivatePageCount),
      cpuMs: (num(p.KernelModeTime) + num(p.UserModeTime)) / 10_000,
      started: startedAt(p.CreationDate)
    })
  }
  return rows
}

export interface TreeUse {
  pids: number[]
  memory: number
  cpuMs: number
}

/**
 * Each root's process and everything under it, by parent links. Windows reuses process ids, so a "child" that started
 * before its parent is someone else's and isn't counted, and no process is counted under two roots.
 */
export function treeUse(rows: ProcessRow[], roots: Map<number, string>): Map<string, TreeUse> {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const children = new Map<number, ProcessRow[]>()
  for (const r of rows) {
    if (r.parent === r.pid) continue
    const list = children.get(r.parent)
    if (list) list.push(r)
    else children.set(r.parent, [r])
  }
  const claimed = new Set<number>()
  const out = new Map<string, TreeUse>()
  for (const [rootPid, id] of roots) {
    const root = byPid.get(rootPid)
    if (!root || claimed.has(rootPid)) continue
    const use: TreeUse = { pids: [], memory: 0, cpuMs: 0 }
    const stack = [root]
    while (stack.length) {
      const p = stack.pop() as ProcessRow
      if (claimed.has(p.pid)) continue
      claimed.add(p.pid)
      use.pids.push(p.pid)
      use.memory += p.memory
      use.cpuMs += p.cpuMs
      for (const c of children.get(p.pid) ?? []) {
        if (!p.started || !c.started || c.started >= p.started) stack.push(c)
      }
    }
    out.set(id, use)
  }
  return out
}

/**
 * CPU used between two readings, as a percent of the whole PC. A process that's new since the last reading counts all
 * its time; one that has gone counts nothing, rather than the total going backwards.
 */
export function cpuPercent(pids: number[], now: Map<number, number>, before: Map<number, number> | null, elapsedMs: number, cores: number): number | null {
  if (!before || !(elapsedMs > 0) || !(cores > 0)) return null
  let used = 0
  for (const pid of pids) {
    const cpu = now.get(pid) ?? 0
    used += Math.max(0, cpu - (before.get(pid) ?? 0))
  }
  return Math.min(100, Math.round((used / elapsedMs / cores) * 1000) / 10)
}
