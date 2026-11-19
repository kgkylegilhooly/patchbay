import { describe, expect, test } from 'vitest'
import type { AgentStatus, CanvasDoc, CanvasNode } from '../../src/shared/model'
import { duration, needsYouQueue, nextInQueue, waitText } from '../../src/renderer/needsYou'
import { ACTIONS } from '../../src/renderer/actions'
import { actionForKey } from '../../src/renderer/keys'
import { statusSections } from '../../src/renderer/sidebarView'

const agent = (id: string, projectId = 'p1'): CanvasNode =>
  ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 400, height: 300, parentId: null, cwd: '/w', sessionId: null, transcriptPath: null, after: [], projectId }) as CanvasNode
const terminal = (id: string): CanvasNode => ({ id, kind: 'terminal', title: id, x: 0, y: 0, width: 400, height: 300, parentId: null, cwd: '/w', projectId: 'p1' }) as CanvasNode

function doc(nodes: CanvasNode[]): CanvasDoc {
  return {
    version: 2,
    projects: [
      { id: 'p1', name: 'One', folder: '/w', viewport: { x: 0, y: 0, zoom: 1 } },
      { id: 'p2', name: 'Two', folder: '/w', viewport: { x: 0, y: 0, zoom: 1 }, closedAt: 5 }
    ],
    activeProjectId: 'p1',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: [],
    closed: []
  } as unknown as CanvasDoc
}

const at = (n: number) => ({ at: n, exact: true })

describe('the queue "Next needing you" walks', () => {
  const nodes = [agent('a'), agent('b'), agent('c', 'p2'), agent('d'), agent('e'), agent('f'), terminal('t')]
  const statuses: Record<string, AgentStatus> = { a: 'needs-you', b: 'needs-you', c: 'needs-you', d: 'idle', e: 'unknown', f: 'exited', t: 'idle' }
  const attention = ['a', 'd', 'f', 't']
  const waits = { a: at(300), b: at(100), c: at(200), d: at(50), e: at(10), f: at(20) }

  test('needs-you first, the longest waiting first, across projects, closed ones included', () => {
    const q = needsYouQueue(doc(nodes), statuses, attention, waits, false)
    expect(q.map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect(q.every((e) => e.bucket === 'needs-you')).toBe(true)
  })

  test('then unread, finished or stopped, oldest first, when asked for', () => {
    const q = needsYouQueue(doc(nodes), statuses, attention, waits, true)
    expect(q.map((e) => [e.id, e.bucket])).toEqual([
      ['b', 'needs-you'],
      ['c', 'needs-you'],
      ['a', 'needs-you'],
      ['f', 'unread'],
      ['d', 'unread']
    ])
  })

  test('unknown stays unknown: never jumped to, however long', () => {
    expect(needsYouQueue(doc(nodes), statuses, attention, waits, true).find((e) => e.id === 'e')).toBeUndefined()
  })

  test("the same sessions as the Status tab's Need attention and Unread sections", () => {
    const sections = statusSections(doc(nodes), statuses, attention, '')
    const ids = (id: string): string[] => sections.find((s) => s.id === id)!.sessions.filter((s) => s.kind === 'claude').map((s) => s.id).sort()
    const q = needsYouQueue(doc(nodes), statuses, attention, waits, true)
    expect(q.filter((e) => e.bucket === 'needs-you').map((e) => e.id).sort()).toEqual(ids('needs-you'))
    expect(q.filter((e) => e.bucket === 'unread').map((e) => e.id).sort()).toEqual(ids('unread'))
  })

  test('only agent windows: a terminal is never in it', () => {
    expect(needsYouQueue(doc(nodes), statuses, attention, waits, true).find((e) => e.id === 't')).toBeUndefined()
  })

  test('one without a time goes first, as it has waited at least as long as Patchbay has known; ties keep canvas order', () => {
    const q = needsYouQueue(doc([agent('x'), agent('y'), agent('z')]), { x: 'needs-you', y: 'needs-you', z: 'needs-you' }, [], { x: at(5), y: at(5) }, false)
    expect(q.map((e) => e.id)).toEqual(['z', 'x', 'y'])
  })

  test('nothing waiting is an empty queue', () => {
    expect(needsYouQueue(doc([agent('a')]), { a: 'working' }, [], {}, true)).toEqual([])
    expect(nextInQueue([], null)).toBeNull()
  })
})

describe('cycling', () => {
  const q = [
    { id: 'b', bucket: 'needs-you' as const, since: 1 },
    { id: 'c', bucket: 'needs-you' as const, since: 2 },
    { id: 'a', bucket: 'unread' as const, since: 3 }
  ]
  test('starts at the oldest, goes on from the last one, and wraps round', () => {
    expect(nextInQueue(q, null)?.id).toBe('b')
    expect(nextInQueue(q, 'b')?.id).toBe('c')
    expect(nextInQueue(q, 'c')?.id).toBe('a')
    expect(nextInQueue(q, 'a')?.id).toBe('b')
  })
  test('back to the start when the last one has left the queue, as when it was answered', () => {
    expect(nextInQueue(q, 'gone')?.id).toBe('b')
  })
})

describe('wait wording', () => {
  test('durations', () => {
    expect(duration(30_000)).toBe('under a minute')
    expect(duration(4 * 60_000)).toBe('4m')
    expect(duration(65 * 60_000)).toBe('1h 5m')
    expect(duration(120 * 60_000)).toBe('2h')
    expect(duration(27 * 3600_000)).toBe('1d 3h')
    expect(duration(-5)).toBe('under a minute')
  })
  test('by status, and a time only found on starting up is a floor', () => {
    const now = 10 * 60_000
    expect(waitText('needs-you', { at: 0, exact: true }, now)).toEqual({ text: 'Waiting 10m', title: undefined })
    expect(waitText('needs-you', { at: 0, exact: false }, now)?.text).toBe('Waiting 10m+')
    expect(waitText('needs-you', { at: 0, exact: false }, now)?.title).toMatch(/may have been longer/)
    expect(waitText('idle', { at: now - 10_000, exact: true }, now)?.text).toBe('Finished just now')
    expect(waitText('idle', { at: 0, exact: true }, now)?.text).toBe('Finished 10m ago')
    expect(waitText('exited', { at: 0, exact: true }, now)?.text).toBe('Stopped 10m ago')
  })
  test("says nothing it can't vouch for", () => {
    expect(waitText('needs-you', null, 0)).toBeNull()
    expect(waitText('unknown', { at: 0, exact: true }, 60_000)).toBeNull()
  })
})

describe('the action', () => {
  test('is in the palette and on Ctrl+Shift+J, which nothing else uses', () => {
    const action = ACTIONS.find((a) => a.id === 'next-needs-you')
    expect(action?.label).toBe('Next needing you')
    expect(ACTIONS.filter((a) => a.key === 'Ctrl+Shift+J')).toHaveLength(1)
    expect(actionForKey('Ctrl+Shift+J', ACTIONS, {})?.id).toBe('next-needs-you')
  })
  test('can be bound to another key', () => {
    expect(actionForKey('Alt+N', ACTIONS, { 'next-needs-you': 'Alt+N' })?.id).toBe('next-needs-you')
  })
})
