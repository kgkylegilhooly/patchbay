import { describe, expect, test } from 'vitest'
import { createResourceMonitor, PROCESS_MIN_GAP_MS, systemMemoryFrom, type ResourceMonitorDeps, type SessionInfo } from '../../src/main/resources/monitor'
import type { PressureKind, ResourceReading, ResourceWarning, SystemMemory } from '../../src/shared/resources'
import { PRESSURE } from '../../src/core/resources/pressure'

const GB = 1024 ** 3
const plenty: SystemMemory = { totalPhys: 16 * GB, availPhys: 8 * GB, commitLimit: 24 * GB, commitAvail: 12 * GB }
const short: SystemMemory = { ...plenty, commitAvail: 1 * GB }

function setup(over: Partial<ResourceMonitorDeps> & { sessions?: SessionInfo[] } = {}) {
  let t = 1_000_000
  let system = plenty
  const queries: number[] = []
  const warnings: ResourceWarning[] = []
  const lows: PressureKind[] = []
  const readings: ResourceReading[] = []
  const processes = JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, Name: 'claude.exe', PrivatePageCount: 400 * 1024 ** 2, KernelModeTime: 0, UserModeTime: 0 },
    { ProcessId: 101, ParentProcessId: 100, Name: 'node.exe', PrivatePageCount: 100 * 1024 ** 2, KernelModeTime: 0, UserModeTime: 0 },
    { ProcessId: 200, ParentProcessId: 1, Name: 'claude.exe', PrivatePageCount: 50 * 1024 ** 2, KernelModeTime: 0, UserModeTime: 0 },
    { ProcessId: 50, ParentProcessId: 1, Name: 'Patchbay Host.exe', PrivatePageCount: 90 * 1024 ** 2, KernelModeTime: 0, UserModeTime: 0 }
  ])
  const sessions: SessionInfo[] = over.sessions ?? [
    { id: 'big', title: 'Big', projectId: 'p', kind: 'agent', pid: 100, status: 'idle', idleSince: t - 3_600_000 },
    { id: 'small', title: 'Small', projectId: 'p', kind: 'agent', pid: 200, status: 'idle', idleSince: t - 7_200_000 },
    { id: 'shell', title: 'Shell', projectId: 'p', kind: 'terminal', pid: null, status: 'unknown', idleSince: null }
  ]
  const monitor = createResourceMonitor({
    appMetrics: () => [
      { type: 'Browser', memory: { privateBytes: 100 * 1024, workingSetSize: 0 } },
      { type: 'Tab', memory: { privateBytes: 200 * 1024, workingSetSize: 0 } }
    ],
    systemMemory: () => system,
    listProcesses: async () => {
      queries.push(t)
      return processes
    },
    sessions: () => sessions,
    hostPid: () => 50,
    agentLimit: () => null,
    cores: 4,
    now: () => t,
    onWarning: (w) => warnings.push(w),
    onLow: (k) => lows.push(k),
    onReading: (r) => readings.push(r),
    ...over
  })
  return {
    monitor,
    queries,
    warnings,
    lows,
    readings,
    advance: (ms: number) => (t += ms),
    setSystem: (s: SystemMemory) => (system = s)
  }
}

describe('the resource monitor', () => {
  test("a plain tick reads only what's cheap: no PowerShell while nobody is looking and memory is fine", async () => {
    const m = setup()
    const r = await m.monitor.tick()
    expect(m.queries).toHaveLength(0)
    expect(r.app).toEqual({ total: 300 * 1024 ** 2, byType: { Browser: 100 * 1024 ** 2, Tab: 200 * 1024 ** 2 } })
    expect(r.sessions.map((s) => s.id)).toEqual(['big', 'small'])
    expect(r.sessions[0].memory).toBeNull()
    expect(r.agents).toEqual({ running: 2, limit: null })
  })

  test('while the view is open, sessions get their process trees, at most once per gap', async () => {
    const m = setup()
    m.monitor.watch(true)
    await m.monitor.tick()
    const r = m.monitor.reading()
    expect(m.queries).toHaveLength(1)
    expect(r.sessions.map((s) => [s.id, s.memory, s.processes])).toEqual([
      ['big', 500 * 1024 ** 2, 2],
      ['small', 50 * 1024 ** 2, 1]
    ])
    expect(r.host).toEqual({ pid: 50, memory: 90 * 1024 ** 2 })
    expect(m.readings.length).toBeGreaterThan(0)
    await m.monitor.tick()
    expect(m.queries).toHaveLength(1)
    m.advance(PROCESS_MIN_GAP_MS)
    await m.monitor.tick()
    expect(m.queries).toHaveLength(2)
    m.monitor.watch(false)
    m.advance(PROCESS_MIN_GAP_MS)
    await m.monitor.tick()
    expect(m.queries).toHaveLength(2)
  })

  test('low commit: one warning naming the idle agents (longest idle first), and the window told once', async () => {
    const m = setup()
    m.setSystem(short)
    await m.monitor.tick()
    expect(m.warnings).toHaveLength(1)
    expect(m.warnings[0].kind).toBe('commit')
    expect(m.warnings[0].suggestions.map((s) => s.id)).toEqual(['small', 'big'])
    expect(m.warnings[0].suggestions[1].memory).toBe(500 * 1024 ** 2)
    expect(m.lows).toEqual(['commit'])
    m.advance(60_000)
    await m.monitor.tick()
    expect(m.warnings).toHaveLength(1)
    expect(m.lows).toEqual(['commit'])
    // Recovered, then short again within the hour: the window lets go again, but no second warning.
    m.setSystem(plenty)
    await m.monitor.tick()
    m.setSystem(short)
    await m.monitor.tick()
    expect(m.lows).toEqual(['commit', 'commit'])
    expect(m.warnings).toHaveLength(1)
    m.advance(PRESSURE.rearmMs)
    await m.monitor.tick()
    expect(m.warnings).toHaveLength(2)
  })

  test("a query that can't start, as when Windows is out of commit, still warns and says why it has no processes", async () => {
    const m = setup({
      listProcesses: async () => {
        throw new Error('spawn powershell.exe EAGAIN')
      }
    })
    m.setSystem(short)
    const r = await m.monitor.tick()
    expect(m.warnings).toHaveLength(1)
    expect(r.processesProblem).toContain('EAGAIN')
    expect(r.processesAt).toBeNull()
  })

  test('more agents than the limit warns, without memory being short', async () => {
    const m = setup({ agentLimit: () => 1 })
    await m.monitor.tick()
    expect(m.warnings.map((w) => w.kind)).toEqual(['agents'])
    expect(m.lows).toEqual([])
  })

  test("Electron's memory reading: KB to bytes, with Windows's commit as swap", () => {
    expect(systemMemoryFrom({ total: 1024, free: 512, swapTotal: 2048, swapFree: 1024 })).toEqual({ totalPhys: 1024 ** 2, availPhys: 512 * 1024, commitLimit: 2 * 1024 ** 2, commitAvail: 1024 ** 2 })
    expect(systemMemoryFrom({ total: 0, free: 0 })).toBeNull()
  })
})
