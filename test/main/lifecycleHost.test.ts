import { describe, expect, test } from 'vitest'
import { decideInstance, EXITING_WAIT_MS, hideNotice, planReconnect, quitMenuLabels, quitQuestion, restoreSeed } from '../../src/main/lifecycle'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

const base = { x: 0, y: 0, width: 10, height: 10, parentId: null, title: 't', cwd: 'C:\\w' }
const term = (id: string): CanvasNode => ({ ...base, id, kind: 'terminal' }) as unknown as CanvasNode
const claude = (id: string, after: string[] = []): CanvasNode => ({ ...base, id, kind: 'claude', sessionId: null, transcriptPath: null, after }) as unknown as CanvasNode
const run = (id: string): CanvasNode => ({ ...base, id, kind: 'run', command: 'x' }) as unknown as CanvasNode
const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes }) as unknown as CanvasDoc

describe('planReconnect', () => {
  test('with an empty host, it is the ordinary restore', () => {
    const plan = planReconnect(doc(term('t'), claude('c'), claude('h', ['c']), run('r')), [])
    expect(plan).toMatchObject({ terminals: ['t'], claude: ['c'], held: ['h'], adopt: [], finishedRuns: [], endedInHost: [], strays: [] })
  })

  test('anything still running is joined and never started again', () => {
    const plan = planReconnect(doc(term('t'), claude('c'), run('r')), [
      { id: 't', running: true },
      { id: 'c', running: true },
      { id: 'r', running: true }
    ])
    expect(plan.adopt).toEqual(['t', 'c', 'r'])
    expect(plan.terminals).toEqual([])
    expect(plan.claude).toEqual([])
  })

  test('a terminal or Claude node that ended in the host is started again, and marked as having output there', () => {
    const plan = planReconnect(doc(term('t'), claude('c')), [
      { id: 't', running: false },
      { id: 'c', running: false }
    ])
    expect(plan.terminals).toEqual(['t'])
    expect(plan.claude).toEqual(['c'])
    expect(plan.endedInHost).toEqual(['t', 'c'])
    expect(plan.adopt).toEqual([])
  })

  test('a run node that ended only reports it, as run nodes never start by themselves', () => {
    const plan = planReconnect(doc(run('r')), [{ id: 'r', running: false }])
    expect(plan.finishedRuns).toEqual(['r'])
    expect(plan.endedInHost).toEqual([])
    expect(plan.adopt).toEqual([])
  })

  test('a held node that is somehow running is joined rather than held', () => {
    const plan = planReconnect(doc(claude('h', ['x'])), [{ id: 'h', running: true }])
    expect(plan.adopt).toEqual(['h'])
    expect(plan.held).toEqual([])
  })

  test('sessions with no node are strays, running or not', () => {
    const plan = planReconnect(doc(term('t')), [
      { id: 'gone', running: true },
      { id: 'also-gone', running: false }
    ])
    expect(plan.strays).toEqual(['gone', 'also-gone'])
  })
})

describe('quitQuestion says what really happens', () => {
  const background = { mode: 'background' as const }
  const inApp = { mode: 'in-process' as const }

  test('leaving sessions running with nothing at stake just goes', () => {
    expect(quitQuestion('leave-running', background, 3, false)).toBeNull()
  })

  test('a busy Claude gets a question that says it keeps running, and offers both ways out', () => {
    const q = quitQuestion('leave-running', background, 1, true)
    expect(q?.message).toMatch(/still working or waiting/)
    expect(q?.message).toMatch(/leaves it running/)
    expect(q?.message).not.toMatch(/stops/)
    expect(q?.detail).toMatch(/terminal/)
    expect(q?.answers).toEqual(['leave-running', 'stop-all', null])
    expect(q?.buttons).toHaveLength(3)
  })

  test('its default is the one that does nothing', () => {
    const q = quitQuestion('leave-running', background, 1, true)
    expect(q?.answers[q.defaultId]).toBeNull()
    expect(q?.answers[q.cancelId]).toBeNull()
  })

  test('asking by name to stop everything only needs a second thought for a busy Claude', () => {
    expect(quitQuestion('stop-all', background, 5, false)).toBeNull()
    const q = quitQuestion('stop-all', background, 5, true)
    expect(q?.message).toMatch(/ends it/)
    expect(q?.answers).toEqual(['stop-all', null])
  })

  test('without a host it never claims sessions keep running, and warns even with only terminals', () => {
    const q = quitQuestion('leave-running', inApp, 2, false)
    expect(q?.message).toMatch(/2 sessions are running inside the app, so quitting ends them/)
    expect(q?.buttons.join(' ')).not.toMatch(/leave running/i)
    expect(q?.answers).toEqual(['stop-all', null])
  })

  test('without a host and with nothing running, it just goes', () => {
    expect(quitQuestion('leave-running', inApp, 0, false)).toBeNull()
  })
})

describe('quitMenuLabels', () => {
  test('nothing running: one plain way out', () => {
    expect(quitMenuLabels(0, { mode: 'background' })).toEqual({ quit: 'Quit', stopAll: null })
  })

  test('sessions in the host: two clear choices', () => {
    expect(quitMenuLabels(2, { mode: 'background' })).toEqual({ quit: 'Quit (sessions keep running)', stopAll: 'Stop all sessions and quit' })
  })

  test('sessions in the app: no promise that they survive', () => {
    expect(quitMenuLabels(2, { mode: 'in-process' })).toEqual({ quit: 'Quit and end all sessions', stopAll: null })
  })
})

test('the divider stays true however the old process ended', () => {
  const seed = restoreSeed('terminal', 'old output') ?? ''
  expect(seed).toMatch(/old process ended/)
  expect(seed).not.toMatch(/when Patchbay closed/)
})

test('the hide notice no longer implies that quitting ends sessions', () => {
  expect(hideNotice(2, false)).toMatch(/2 sessions still running/)
  expect(hideNotice(2, false)).toMatch(/tray/)
  expect(hideNotice(2, true)).toBeNull()
})

describe('decideInstance', () => {
  const now = 100000
  const alive = (): boolean => true
  const dead = (): boolean => false

  test('with the lock, this launch runs', () => {
    expect(decideInstance(true, { pid: 1, at: now }, now, alive)).toBe('run')
  })

  test('without it and with nothing exiting, the running instance comes forward instead', () => {
    expect(decideInstance(false, null, now, alive)).toBe('focus-and-quit')
  })

  test('an instance that has just started exiting is waited for, rather than quitting with no window', () => {
    expect(decideInstance(false, { pid: 1, at: now - 1000 }, now, alive)).toBe('wait')
  })

  test('a mark left by a process that has gone, or from long ago, is ignored', () => {
    expect(decideInstance(false, { pid: 1, at: now - 1000 }, now, dead)).toBe('focus-and-quit')
    expect(decideInstance(false, { pid: 1, at: now - EXITING_WAIT_MS - 5000 }, now, alive)).toBe('focus-and-quit')
  })
})
