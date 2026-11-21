import { expect, test } from 'vitest'
import { sessionLines, shownLine, syncSummary } from '../../src/renderer/resources/resourcesUi'
import type { ResourceReading, SessionUse } from '../../src/shared/resources'
import type { SyncReport, SyncRow } from '../../src/shared/sessionSync'

const MB = 1024 ** 2
const use = (id: string, memory: number | null, over: Partial<SessionUse> = {}): SessionUse => ({ id, title: id, projectId: 'p', kind: 'agent', status: 'working', pid: 1, idleSince: null, memory, cpu: 2, processes: 3, ...over })
const reading = (sessions: SessionUse[]): ResourceReading => ({ at: 0, system: null, app: { total: 0, byType: {} }, host: null, sessions, processesAt: 0, agents: { running: 0, limit: null } })
const row = (id: string, over: Partial<SyncRow> = {}): SyncRow => ({ id, title: id, kind: 'claude', running: true, pid: 10, alive: true, shown: 'working', problem: null, ...over })
const report = (rows: SyncRow[]): SyncReport => ({ at: 0, hostReached: true, rows })

test("one line per host session, joined with what it uses; the largest first, then the check's order", () => {
  const lines = sessionLines(report([row('a'), row('orphan', { title: null, kind: null, shown: null, problem: 'orphan' }), row('ended', { running: false, pid: null, shown: 'exited' }), row('b')]), reading([use('a', 100 * MB), use('b', 400 * MB), use('orphan', 50 * MB, { kind: 'unknown', title: '' })]))
  expect(lines.map((l) => [l.id, l.use?.memory ?? null, l.sync?.problem ?? null])).toEqual([
    ['b', 400 * MB, null],
    ['a', 100 * MB, null],
    ['orphan', 50 * MB, 'orphan'],
    ['ended', null, null]
  ])
  expect(lines[2].title).toBeNull()
})

test('without a check, as when sessions run in the app, the reading alone lists them', () => {
  const lines = sessionLines({ at: 0, hostReached: false, rows: [] }, reading([use('x', MB), use('y', null, { kind: 'unknown', title: '' })]))
  expect(lines.map((l) => [l.id, l.title, l.sync])).toEqual([
    ['x', 'x', null],
    ['y', null, null]
  ])
  expect(sessionLines(null, null)).toEqual([])
})

test("what the canvas shows, in the status system's words, with idle time", () => {
  const now = 10 * 60_000
  const [idle] = sessionLines(report([row('i', { shown: 'idle' })]), reading([use('i', MB, { status: 'idle', idleSince: 0 })]))
  expect(shownLine(idle, now)).toBe('Idle 10 min')
  const [term] = sessionLines(report([row('t', { kind: 'terminal', shown: null })]), null)
  expect(shownLine(term, now)).toBe('Running')
  const [needs] = sessionLines(null, reading([use('n', MB, { status: 'needs-you' })]))
  expect(shownLine(needs, now)).toBe('Needs you')
  const [orphan] = sessionLines(report([row('o', { title: null, shown: null, problem: 'orphan' })]), null)
  expect(shownLine(orphan, now)).toBe('—')
})

test("the check's summary", () => {
  expect(syncSummary(null)).toBe('Not checked yet.')
  expect(syncSummary({ at: 0, hostReached: false, rows: [] })).toBe('There was no background host to ask.')
  expect(syncSummary(report([row('a')]))).toBe('1 session, each matching its node.')
  expect(syncSummary(report([row('a'), row('b', { problem: 'orphan' })]))).toMatch(/^1 of 2 didn't match/)
})
