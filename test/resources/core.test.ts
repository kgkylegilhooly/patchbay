import { describe, expect, test } from 'vitest'
import { agentLimitReason, parseAgentLimit } from '../../src/core/resources/agentLimit'
import { cpuPercent, parseProcessRows, treeUse, type ProcessRow } from '../../src/core/resources/processes'
import { buildWarning, idleSuggestions, noteCleared, PRESSURE, pressureNow, shouldWarn, type WarnedAt } from '../../src/core/resources/pressure'
import type { SessionUse, SystemMemory } from '../../src/shared/resources'

const GB = 1024 ** 3
const row = (pid: number, parent: number, memory: number, started = 1000, cpuMs = 0): ProcessRow => ({ pid, parent, name: `p${pid}`, memory, cpuMs, started })

describe('the process query', () => {
  test('reads PowerShell 5 rows: CPU in 100 ns units, a start date as /Date(ms)/', () => {
    const json = JSON.stringify([
      { ProcessId: 10, ParentProcessId: 4, Name: 'claude.exe', PrivatePageCount: 500, KernelModeTime: 10_000, UserModeTime: 30_000, CreationDate: '/Date(1700000000000)/' },
      { ProcessId: 11, ParentProcessId: 10, Name: 'node.exe', PrivatePageCount: '200', KernelModeTime: null, UserModeTime: 10_000, CreationDate: { value: '/Date(1700000001000)/' } }
    ])
    expect(parseProcessRows(json)).toEqual([
      { pid: 10, parent: 4, name: 'claude.exe', memory: 500, cpuMs: 4, started: 1700000000000 },
      { pid: 11, parent: 10, name: 'node.exe', memory: 200, cpuMs: 1, started: 1700000001000 }
    ])
  })

  test('a single process, rubbish, or an empty answer', () => {
    expect(parseProcessRows(JSON.stringify({ ProcessId: 3, ParentProcessId: 0 }))).toHaveLength(1)
    expect(parseProcessRows('not json')).toEqual([])
    expect(parseProcessRows('')).toEqual([])
    expect(parseProcessRows('[null, {"Name": "no id"}]')).toEqual([])
  })
})

describe("a session's process tree", () => {
  test('adds up the root and everything under it, at any depth', () => {
    const rows = [row(1, 0, 100), row(2, 1, 50), row(3, 2, 25), row(9, 0, 1000)]
    const use = treeUse(rows, new Map([[1, 'a']]))
    expect(use.get('a')).toEqual({ pids: expect.arrayContaining([1, 2, 3]), memory: 175, cpuMs: 0 })
    expect(use.get('a')?.pids).toHaveLength(3)
  })

  test("a reused process id isn't counted: a child that started before its parent belongs to someone else", () => {
    const rows = [row(1, 0, 100, 5000), row(2, 1, 50, 4000), row(3, 1, 10, 6000)]
    expect(treeUse(rows, new Map([[1, 'a']])).get('a')?.memory).toBe(110)
  })

  test('no process counts twice, a loop ends, and a root that has gone has no entry', () => {
    const rows = [row(1, 2, 10), row(2, 1, 20), row(5, 0, 7)]
    const use = treeUse(rows, new Map([[1, 'a'], [2, 'b'], [77, 'gone']]))
    expect(use.get('a')?.memory).toBe(30)
    expect(use.has('b')).toBe(false)
    expect(use.has('gone')).toBe(false)
  })

  test('CPU between readings, as a share of the whole PC; gone processes never make it go backwards', () => {
    const before = new Map([[1, 1000], [2, 500], [3, 900]])
    const now = new Map([[1, 1600], [2, 500], [4, 200]])
    // 600 ms by pid 1 and 200 by the new pid 4, over 1 s on 4 cores: 800 / 4000.
    expect(cpuPercent([1, 2, 4], now, before, 1000, 4)).toBe(20)
    expect(cpuPercent([1], now, null, 1000, 4)).toBeNull()
    expect(cpuPercent([1], new Map([[1, 0]]), before, 1000, 4)).toBe(0)
  })
})

const sys = (commitFreeShare: number, physFreeShare = 0.5): SystemMemory => ({ totalPhys: 16 * GB, availPhys: 16 * GB * physFreeShare, commitLimit: 24 * GB, commitAvail: 24 * GB * commitFreeShare })
const session = (id: string, idleSince: number | null, memory: number | null, kind: SessionUse['kind'] = 'agent'): SessionUse => ({ id, title: id, projectId: null, kind, status: idleSince === null ? 'working' : 'idle', idleSince, memory, cpu: null, processes: null })
const none = { running: 2, limit: null }

describe('when to warn', () => {
  test('commit nearly used up comes first, then RAM, then too many agents', () => {
    expect(pressureNow(sys(0.05, 0.01), { running: 9, limit: 4 })).toBe('commit')
    expect(pressureNow(sys(0.5, 0.03), { running: 9, limit: 4 })).toBe('physical')
    expect(pressureNow(sys(0.5), { running: 5, limit: 4 })).toBe('agents')
    expect(pressureNow(sys(0.5), { running: 4, limit: 4 })).toBeNull()
    expect(pressureNow(sys(0.5), none)).toBeNull()
    expect(pressureNow(null, none)).toBeNull()
  })

  test('the lines sit where they say', () => {
    expect(pressureNow(sys(PRESSURE.commitFree + 0.01), none)).toBeNull()
    expect(pressureNow(sys(PRESSURE.commitFree - 0.01), none)).toBe('commit')
  })

  test('said once; again only after it ended, came back, and the re-arm time passed', () => {
    const t = 1_000_000
    expect(shouldWarn('commit', {}, t)).toBe(true)
    const warned: WarnedAt = { commit: { at: t, cleared: false } }
    expect(shouldWarn('commit', warned, t + 60_000)).toBe(false)
    // A shortage that simply lasts is said once.
    noteCleared(warned, 'commit')
    expect(shouldWarn('commit', warned, t + 5 * PRESSURE.rearmMs)).toBe(false)
    // It ended, and came back: said again, but not within the re-arm time.
    noteCleared(warned, null)
    expect(shouldWarn('commit', warned, t + 60_000)).toBe(false)
    expect(shouldWarn('commit', warned, t + PRESSURE.rearmMs)).toBe(true)
    // Each kind keeps its own record.
    expect(shouldWarn('physical', { commit: { at: t, cleared: false } }, t + 1)).toBe(true)
    expect(shouldWarn(null, {}, t)).toBe(false)
  })

  test('suggests idle agents only: the longest idle first, then the largest', () => {
    const list = [session('busy', null, 9 * GB), session('term', 100, 9 * GB, 'terminal'), session('new', 900, 5 * GB), session('old-small', 100, 1 * GB), session('old-big', 100, 2 * GB), session('mid', 500, null)]
    expect(idleSuggestions(list).map((s) => s.id)).toEqual(['old-big', 'old-small', 'mid'])
    expect(idleSuggestions(list, 10).map((s) => s.id)).toEqual(['old-big', 'old-small', 'mid', 'new'])
  })

  test('the warning says how much is left and names what to close', () => {
    const w = buildWarning('commit', sys(0.05), none, [session('a', 10, GB)])
    expect(w.text).toContain('1.2 GB of 24.0 GB left')
    expect(w.suggestions).toEqual([{ id: 'a', title: 'a', memory: GB, idleSince: 10 }])
    expect(buildWarning('agents', null, { running: 7, limit: 5 }, []).text).toMatch(/7 agents are running, over your limit of 5\. Nothing was stopped/)
  })
})

describe('the soft limit on agents', () => {
  test('blank, zero or rubbish is no limit; numbers are whole and capped', () => {
    expect(parseAgentLimit(undefined)).toBeNull()
    expect(parseAgentLimit('')).toBeNull()
    expect(parseAgentLimit('0')).toBeNull()
    expect(parseAgentLimit('six')).toBeNull()
    expect(parseAgentLimit(' 6 ')).toBe(6)
    expect(parseAgentLimit('6.7')).toBe(6)
    expect(parseAgentLimit('500')).toBe(99)
  })

  test('stops only the one past the limit, and says why and what to do', () => {
    expect(agentLimitReason(null, 40)).toBeNull()
    expect(agentLimitReason(3, 2)).toBeNull()
    expect(agentLimitReason(3, 3)).toMatch(/^Not started: 3 agents are already running, and your limit is 3 \(Settings > Background sessions\)\. Close or stop one/)
    expect(agentLimitReason(1, 1)).toContain('1 agent is already running')
  })
})
