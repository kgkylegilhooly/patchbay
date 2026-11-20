import { describe, expect, test } from 'vitest'
import type { AgentStop } from '../../src/shared/agentStop'
import type { AgentStatus, CanvasDoc, CanvasNode } from '../../src/shared/model'
import { agentLook, attemptLook, AGENT_LABELS, runFailed, runLook, subagentLook, workflowRunLook, TONE_ORDER, TONE_TOKENS, type Tone } from '../../src/renderer/status/status'
import { BUCKETS } from '../../src/renderer/sidebarView'
import { needsYouQueue } from '../../src/renderer/needsYou'
import { projectSignal, SIGNAL_TONE } from '../../src/renderer/projectSignal'
import { ATTEMPT_LABEL, RUN_STATE_LABEL } from '../../src/renderer/workflows/runView'

const now = Date.parse('2026-11-20T12:00:00')
const stop = (patch: Partial<AgentStop>): AgentStop => ({ kind: 'error', at: now, until: null, message: null, holds: null, ...patch })
const run = (patch: Partial<{ running: boolean; exitCode: number | null; stoppedByYou: boolean }>) => ({ running: false, exitCode: null, stoppedByYou: false, at: now, ...patch })

describe('agents', () => {
  test('each status has one tone and one sentence-case word, and Unknown is never shown', () => {
    const looks = (Object.keys(AGENT_LABELS) as AgentStatus[]).map((s) => [s, agentLook(s).tone, agentLook(s).label])
    expect(looks).toEqual([
      ['queued', 'pending', 'Queued'],
      ['starting', 'pending', 'Starting'],
      ['working', 'working', 'Working'],
      ['idle', 'done', 'Idle'],
      ['needs-you', 'needs', 'Needs you'],
      ['exited', 'ended', 'Exited'],
      ['unknown', 'unknown', 'No status yet']
    ])
  })

  test('a terminal, which has no status, is its own tone, never a status colour', () => {
    expect(agentLook(null).tone).toBe('none')
  })

  test('a stop the person has to clear is held; one that clears by itself waits until its reset, then is held', () => {
    expect(agentLook('unknown', stop({ kind: 'auth', holds: 'person' }), now)).toMatchObject({ tone: 'held', label: 'Login failed' })
    expect(agentLook('unknown', stop({ kind: 'error' }), now)).toMatchObject({ tone: 'held', label: 'Stopped on an error' })
    const limit = stop({ kind: 'usage-limit', holds: 'reset', until: now + 30 * 60_000, message: 'You hit your limit' })
    expect(agentLook('unknown', limit, now)).toMatchObject({ tone: 'waits', label: 'Usage limit until 12:30', detail: 'Usage limit until 12:30\nYou hit your limit' })
    expect(agentLook('unknown', limit, now + 3600_000).tone).toBe('held')
  })

  test('a stop only counts while the status is still unknown', () => {
    expect(agentLook('working', stop({ holds: 'person' }), now).tone).toBe('working')
  })
})

describe('runs, subagents and workflow steps use the same tones', () => {
  test('a run command: amber while running, green on exit 0, a red ring on failure, dim when stopped, a square before it ever ran', () => {
    expect(runLook(undefined)).toEqual({ tone: 'none', label: 'Not running' })
    expect(runLook(run({ running: true }))).toEqual({ tone: 'working', label: 'Running' })
    expect(runLook(run({ exitCode: 1 }))).toEqual({ tone: 'held', label: 'Exited 1' })
    expect(runLook(run({ exitCode: 0 }))).toEqual({ tone: 'done', label: 'Exited 0' })
    expect(runLook(run({ exitCode: 1, stoppedByYou: true }))).toEqual({ tone: 'ended', label: 'Stopped' })
    expect(runFailed(run({ exitCode: 2 }))).toBe(true)
    expect(runFailed(run({ exitCode: 2, stoppedByYou: true }))).toBe(false)
  })

  test('subagents', () => {
    expect([subagentLook('running').tone, subagentLook('done').tone, subagentLook('failed').tone]).toEqual(['working', 'done', 'held'])
  })

  test('a workflow waiting for your decision needs you (red), not blue; an interrupted one is held', () => {
    expect(workflowRunLook('waiting-for-you')).toEqual({ tone: 'needs', label: 'Needs you' })
    expect(workflowRunLook('needs-attention')).toEqual({ tone: 'held', label: 'Interrupted' })
    expect(attemptLook('waiting-for-you')).toEqual({ tone: 'needs', label: 'Needs you' })
    expect(attemptLook('waiting-for-you', true)).toEqual({ tone: 'needs', label: 'Idle, no result' })
    expect(attemptLook('pending').tone).toBe('pending')
    expect(attemptLook('superseded')).toEqual({ tone: 'ended', label: 'Replaced' })
  })

  test("the panel's word tables are the status system's", () => {
    expect(RUN_STATE_LABEL['waiting-for-you']).toBe('Needs you')
    expect(RUN_STATE_LABEL.succeeded).toBe('Done')
    expect(ATTEMPT_LABEL.launching).toBe('Starting')
  })
})

test('every tone has a token and a place in the order', () => {
  const tones = Object.keys(TONE_TOKENS) as Tone[]
  expect([...tones].sort()).toEqual([...TONE_ORDER].sort())
})

test("the Status tab's sections use the badges' words and carry their tone", () => {
  expect(BUCKETS.map((b) => [b.id, b.label, b.tone])).toEqual([
    ['needs-you', 'Need attention', 'needs'],
    ['unread', 'Unread', null],
    ['running', 'Working', 'working'],
    ['idle', 'Idle', 'done'],
    ['unknown', 'No status yet', 'unknown'],
    ['starting', 'Starting', 'pending'],
    ['stopped', 'Exited', 'ended'],
    ['plain', 'Terminals and commands', 'none']
  ])
})

const agent = (id: string, projectId = 'p'): CanvasNode => ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: '', sessionId: null, transcriptPath: null, after: [], projectId })
const docOf = (nodes: CanvasNode[]): CanvasDoc => ({ version: 2, projects: [{ id: 'p', name: 'P', folder: '' }], activeProjectId: 'p', viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges: [], closed: [] }) as unknown as CanvasDoc

test('Next needing you goes to someone waiting on an answer, then a held stop, then a limit, then unread', () => {
  const doc = docOf([agent('limit'), agent('login'), agent('asks'), agent('done')])
  const statuses: Record<string, AgentStatus> = { limit: 'unknown', login: 'unknown', asks: 'needs-you', done: 'idle' }
  const stops = { limit: stop({ kind: 'usage-limit', holds: 'reset', until: now + 1000 }), login: stop({ kind: 'auth', holds: 'person' }) }
  expect(needsYouQueue(doc, statuses, ['done'], {}, true, stops).map((e) => e.id)).toEqual(['asks', 'login', 'limit', 'done'])
})

test("a project's tab shows a stopped agent as held, after someone waiting on you", () => {
  const doc = docOf([agent('a'), agent('b')])
  expect(projectSignal(doc, { a: 'unknown', b: 'working' }, 'p', [], { a: stop({}) })).toBe('stopped')
  expect(projectSignal(doc, { a: 'unknown', b: 'needs-you' }, 'p', [], { a: stop({}) })).toBe('needs-you')
  expect(projectSignal(doc, { a: 'unknown', b: 'working' }, 'p')).toBe('working')
  expect(SIGNAL_TONE.stopped).toBe('held')
  expect(SIGNAL_TONE.unseen).toBeNull()
})
