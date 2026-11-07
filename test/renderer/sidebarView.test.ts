import { describe, expect, test } from 'vitest'
import { bucketOf, closedProjects, projectBadge, projectSections, recentlyClosed, relativeTime, statusSections, type BucketId } from '../../src/renderer/sidebarView'
import type { AgentStatus, CanvasDoc, CanvasNode, Project } from '../../src/shared/model'

const viewport = { x: 0, y: 0, zoom: 1 }
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id.toUpperCase(), folder: '', viewport, ...over })
const box = { x: 0, y: 0, width: 100, height: 100, parentId: null as string | null }
const claude = (id: string, projectId = 'a', title = id): CanvasNode => ({ ...box, id, title, kind: 'claude', cwd: 'C:\\repo', sessionId: null, transcriptPath: null, after: [], projectId })
const terminal = (id: string, projectId = 'a'): CanvasNode => ({ ...box, id, title: id, kind: 'terminal', cwd: 'C:\\other', projectId })
const run = (id: string, projectId = 'a'): CanvasNode => ({ ...box, id, title: id, kind: 'run', cwd: 'C:\\other', command: 'x', projectId })
const docOf = (nodes: CanvasNode[], projects = [project('a'), project('b')]): CanvasDoc => ({
  version: 3, projects, activeProjectId: 'a', nodes, edges: [], closed: [], viewport
})

const sectionsById = (doc: CanvasDoc, statuses: Record<string, AgentStatus>, attention: string[] = [], query = '') =>
  Object.fromEntries(statusSections(doc, statuses, attention, query).map((s) => [s.id, s.sessions.map((n) => n.id)]))

describe('status buckets', () => {
  const cases: [AgentStatus | null, BucketId][] = [
    ['needs-you', 'needs-you'],
    ['working', 'running'],
    ['idle', 'idle'],
    ['unknown', 'unknown'],
    ['queued', 'starting'],
    ['starting', 'starting'],
    ['exited', 'stopped']
  ]
  test.each(cases)('a Claude session that is %s goes under %s', (status, bucket) => {
    expect(bucketOf('claude', status, false)).toBe(bucket)
  })

  test('only an idle status ever reaches Idle', () => {
    for (const status of ['queued', 'starting', 'exited', 'unknown', 'working', 'needs-you', null] as const) {
      for (const kind of ['claude', 'terminal', 'run'] as const) expect(bucketOf(kind, status, false)).not.toBe('idle')
    }
  })

  test('a Claude session with no status yet is Unknown, not Idle', () => {
    expect(bucketOf('claude', null, false)).toBe('unknown')
  })

  test('terminals and run commands with no status get a section of their own', () => {
    expect(bucketOf('terminal', null, false)).toBe('plain')
    expect(bucketOf('run', null, false)).toBe('plain')
  })

  test('a terminal whose process ended is Stopped', () => {
    expect(bucketOf('terminal', 'exited', false)).toBe('stopped')
  })

  test('waiting on you beats unread, and unread beats everything else', () => {
    expect(bucketOf('claude', 'needs-you', true)).toBe('needs-you')
    expect(bucketOf('claude', 'idle', true)).toBe('unread')
    expect(bucketOf('claude', 'exited', true)).toBe('unread')
    expect(bucketOf('terminal', null, true)).toBe('unread')
  })
})

describe('the Status tab', () => {
  test('the five main sections always show, in order, and the others only when they hold something', () => {
    expect(statusSections(docOf([]), {}, [], '').map((s) => s.id)).toEqual(['needs-you', 'unread', 'running', 'idle', 'unknown'])
    const doc = docOf([claude('q'), terminal('t'), claude('x')])
    expect(statusSections(doc, { q: 'queued', x: 'exited' }, [], '').map((s) => s.id)).toEqual(['needs-you', 'unread', 'running', 'idle', 'unknown', 'starting', 'stopped', 'plain'])
  })

  test('lists sessions across projects, each exactly once', () => {
    const doc = docOf([claude('a1'), claude('b1', 'b'), claude('b2', 'b'), terminal('t', 'b')])
    const sections = statusSections(doc, { a1: 'needs-you', b1: 'working', b2: 'idle' }, ['a1', 'b2'], '')
    const all = sections.flatMap((s) => s.sessions.map((n) => n.id)).sort()
    expect(all).toEqual(['a1', 'b1', 'b2', 't'])
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.sessions.map((n) => n.id)]))
    expect(byId['needs-you']).toEqual(['a1'])
    expect(byId.unread).toEqual(['b2'])
    expect(byId.running).toEqual(['b1'])
    expect(byId.plain).toEqual(['t'])
  })

  test('notes and groups are not sessions', () => {
    const doc = docOf([{ ...box, id: 'n', title: 'n', kind: 'sticky', text: '', projectId: 'a' }, { ...box, id: 'g', title: 'g', kind: 'group', worktree: null, projectId: 'a' }])
    expect(statusSections(doc, {}, [], '').flatMap((s) => s.sessions)).toEqual([])
  })

  test('the filter matches title, folder and project', () => {
    const doc = docOf([claude('one', 'a', 'Fix login'), claude('two', 'b', 'Write docs'), terminal('three', 'a')])
    expect(sectionsById(doc, {}, [], 'login').unknown).toEqual(['one'])
    expect(sectionsById(doc, {}, [], 'c:\\other').plain).toEqual(['three'])
    expect(sectionsById(doc, {}, [], 'B').unknown).toEqual(['two'])
  })

  test('a closed project stays out of sight, except what it needs from you', () => {
    const projects = [project('a'), project('b', { closedAt: 5 })]
    const doc = docOf([claude('needs', 'b'), claude('done', 'b'), claude('busy', 'b'), terminal('t', 'b')], projects)
    const byId = sectionsById(doc, { needs: 'needs-you', done: 'idle', busy: 'working' }, ['done'])
    expect(byId['needs-you']).toEqual(['needs'])
    expect(byId.unread).toEqual(['done'])
    expect(byId.running).toEqual([])
    expect(byId.plain).toBeUndefined()
  })
})

describe('the Project tab', () => {
  test('lists every open project in tab order, and leaves out closed ones', () => {
    const doc = docOf([claude('a1'), claude('b1', 'b'), claude('c1', 'c')], [project('a'), project('b'), project('c', { closedAt: 3 })])
    expect(projectSections(doc, '').map((s) => [s.project.id, s.count])).toEqual([['a', 1], ['b', 1]])
  })

  test('an empty project still shows, unless a filter is hiding things', () => {
    const doc = docOf([claude('a1', 'a', 'Find me')])
    expect(projectSections(doc, '').map((s) => s.project.id)).toEqual(['a', 'b'])
    expect(projectSections(doc, 'find').map((s) => s.project.id)).toEqual(['a'])
  })

  test('keeps group sections within a project', () => {
    const group: CanvasNode = { ...box, id: 'g', title: 'Team', kind: 'group', worktree: null, projectId: 'b' }
    const doc = docOf([group, { ...claude('in', 'b'), parentId: 'g' }, claude('out', 'b')])
    const b = projectSections(doc, '').find((s) => s.project.id === 'b')!
    expect(b.tree.groups.map((g) => g.sessions.map((s) => s.id))).toEqual([['in']])
    expect(b.tree.ungrouped.map((s) => s.id)).toEqual(['out'])
    expect(b.count).toBe(2)
  })
})

describe('closed lists', () => {
  test('closed projects list the most recent first', () => {
    const doc = docOf([], [project('a'), project('b', { closedAt: 5 }), project('c', { closedAt: 9 })])
    expect(closedProjects(doc).map((p) => p.id)).toEqual(['c', 'b'])
  })

  test('recently closed sessions list the newest first and take the filter', () => {
    const entry = (id: string, closedAt: number) => ({ id, title: `Chat ${id}`, cwd: 'C:\\x', sessionId: id, transcriptPath: null, closedAt })
    const doc = { ...docOf([]), closed: [entry('old', 1), entry('new', 2)] }
    expect(recentlyClosed(doc, '').map((c) => c.id)).toEqual(['new', 'old'])
    expect(recentlyClosed(doc, 'OLD').map((c) => c.id)).toEqual(['old'])
  })
})

describe('small things', () => {
  const now = 10_000_000_000
  test('relative times', () => {
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now + 5_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 50 * 3_600_000, now)).toBe('2d ago')
  })

  test('a badge is the first letter, and stays the same color for a project', () => {
    expect(projectBadge({ id: 'x', name: 'website' }).letter).toBe('W')
    expect(projectBadge({ id: 'x', name: ' ' }).letter).toBe('?')
    expect(projectBadge({ id: 'x', name: 'a' }).color).toBe(projectBadge({ id: 'x', name: 'b' }).color)
  })
})
