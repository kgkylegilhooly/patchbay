import { execFile, fork } from 'node:child_process'
import type { PortInfo } from '../../shared/contract'

export interface Listener {
  port: number
  pid: number
}

type ProcessMap = Map<number, { parent: number; name: string }>

/**
 * Listening sockets from `netstat -ano`. Windows translates the LISTENING word on some languages, and then this
 * finds nothing rather than anything wrong.
 */
export function parseNetstat(text: string): Listener[] {
  const found = new Map<number, number>()
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue
    const port = Number(parts[1].slice(parts[1].lastIndexOf(':') + 1))
    const pid = Number(parts[4])
    if (Number.isInteger(port) && port > 0 && Number.isInteger(pid) && !found.has(port)) found.set(port, pid)
  }
  return [...found].map(([port, pid]) => ({ port, pid }))
}

export function parseProcesses(json: string): ProcessMap {
  const map: ProcessMap = new Map()
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return map
  }
  for (const p of (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>) {
    if (typeof p?.ProcessId === 'number' && typeof p.ParentProcessId === 'number') {
      map.set(p.ProcessId, { parent: p.ParentProcessId, name: typeof p.Name === 'string' ? p.Name : '' })
    }
  }
  return map
}

/** Which session each port belongs to, by walking up from the listening process to a session's root. */
export function matchPorts(listeners: Listener[], processes: ProcessMap, roots: Map<number, string>): Record<string, PortInfo[]> {
  const out: Record<string, PortInfo[]> = {}
  for (const { port, pid } of listeners) {
    const seen = new Set<number>()
    for (let at: number | undefined = pid; at !== undefined && !seen.has(at); at = processes.get(at)?.parent) {
      seen.add(at)
      const nodeId = roots.get(at)
      if (!nodeId) continue
      ;(out[nodeId] ??= []).push({ port, name: (processes.get(pid)?.name ?? '').replace(/\.exe$/i, '') })
      break
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.port - b.port)
  return out
}

export interface PortWatcher {
  tick(): Promise<void>
  current(): Record<string, PortInfo[]>
  onChange(cb: () => void): void
  canOpen(nodeId: string, port: number): boolean
}

export function createPortWatcher({
  runNetstat,
  runProcessList,
  roots,
  visible,
  consoleMembers = async () => []
}: {
  runNetstat: () => Promise<string>
  runProcessList: () => Promise<string>
  roots: () => Map<number, string>
  visible: () => boolean
  /**
   * Every process sharing a session's console. Git Bash's own programs replace their parent when they start, so a
   * server's parent chain can stop short of the session, though something above it is still on that console.
   */
  consoleMembers?: (rootPid: number) => Promise<number[]>
}): PortWatcher {
  let current: Record<string, PortInfo[]> = {}
  let processes: ProcessMap = new Map()
  let knownIds = ''
  let members = new Map<number, string>()
  let ticking: Promise<void> | null = null
  const listeners: Array<() => void> = []

  const run = async (): Promise<void> => {
    if (!visible()) return
    const rootMap = roots()
    let found: Listener[]
    try {
      found = parseNetstat(await runNetstat())
    } catch {
      return
    }
    // Listing every process is the slow part, and its answer only matters when something new appears.
    const ids = JSON.stringify([[...new Set(found.map((l) => l.pid))].sort(), [...rootMap.keys()].sort()])
    if (ids !== knownIds) {
      try {
        processes = parseProcesses(await runProcessList())
        const found = await Promise.all([...rootMap].map(async ([pid, nodeId]) => ({ nodeId, pids: await consoleMembers(pid).catch(() => []) })))
        members = new Map(found.flatMap(({ nodeId, pids }) => pids.map((pid): [number, string] => [pid, nodeId])))
        knownIds = ids
      } catch {
        return
      }
    }
    const next = matchPorts(found, processes, new Map([...members, ...rootMap]))
    if (JSON.stringify(next) === JSON.stringify(current)) return
    current = next
    for (const cb of listeners) cb()
  }

  return {
    tick() {
      ticking ??= run().finally(() => {
        ticking = null
      })
      return ticking
    },
    current: () => current,
    onChange(cb) {
      listeners.push(cb)
    },
    canOpen: (nodeId, port) => !!current[nodeId]?.some((p) => p.port === port)
  }
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

const CONSOLE_LIMIT_MS = 3000

/**
 * node-pty's helper, in a process of its own because attaching to another console would detach this one.
 * It fails harmlessly for a session that has just ended.
 */
export function readConsoleMembers(rootPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const agent = fork(require.resolve('node-pty/lib/conpty_console_list_agent'), [String(rootPid)], { silent: true })
    const timer = setTimeout(() => {
      agent.kill()
      resolve([])
    }, CONSOLE_LIMIT_MS)
    agent.on('message', (message: { consoleProcessList?: number[] }) => {
      clearTimeout(timer)
      resolve(message.consoleProcessList ?? [])
    })
    agent.on('error', () => resolve([]))
    agent.on('exit', () => resolve([]))
  })
}

export const runNetstat = (): Promise<string> => run('netstat', ['-ano'])

export const runProcessList = (): Promise<string> =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'])
