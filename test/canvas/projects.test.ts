import { expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { migrate } from '../../src/core/persist/docStore'
import { dragOps } from '../../src/renderer/dragOps'
import { toFlow } from '../../src/renderer/flowMapping'
import { projectSessions, projectSignal } from '../../src/renderer/projectSignal'
import { sessionTree } from '../../src/renderer/sessionTree'
import type { CanvasDoc, CanvasNode, Project, TerminalNode } from '../../src/shared/model'

const view = (x = 0) => ({ x, y: 0, zoom: 1 })
const project = (id: string, viewport = view()): Project => ({ id, name: id.toUpperCase(), folder: '', viewport })
const terminal = (id: string, projectId?: string, over: Partial<TerminalNode> = {}): TerminalNode => ({
  id,
  kind: 'terminal',
  title: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  parentId: null,
  cwd: 'C:\\x',
  ...(projectId ? { projectId } : {}),
  ...over
})
const group = (id: string, projectId: string): CanvasNode => ({ id, kind: 'group', title: id, x: 0, y: 0, width: 500, height: 500, parentId: null, worktree: null, projectId })

const twoProjects = (nodes: CanvasNode[] = []): CanvasDoc => ({
  version: 3,
  projects: [project('a'), project('b', view(50))],
  activeProjectId: 'a',
  nodes,
  edges: [],
  closed: [],
  viewport: view(10)
})

test('a new node joins the project on screen', () => {
  const doc = reduce(twoProjects(), { op: 'addNode', node: terminal('t') })
  expect(doc.nodes[0].projectId).toBe('a')
})

test("an agent's node joins the agent's project, even with another project on screen", () => {
  const doc = reduce(twoProjects([terminal('agent', 'b')]), { op: 'addNode', node: terminal('t', undefined, { openedBy: 'agent' }) })
  expect(doc.nodes.find((n) => n.id === 't')?.projectId).toBe('b')
})

test("a node in a group joins the group's project", () => {
  const doc = reduce(twoProjects([group('g', 'b')]), { op: 'addNode', node: terminal('t', undefined, { parentId: 'g' }) })
  expect(doc.nodes.find((n) => n.id === 't')?.projectId).toBe('b')
})

test('a node from another project cannot be put in a group', () => {
  const doc = twoProjects([group('g', 'b'), terminal('t', 'a')])
  expect(reduce(doc, { op: 'setParent', ids: ['t'], parentId: 'g' })).toBe(doc)
})

test('switching keeps each project its own view', () => {
  const there = reduce(twoProjects(), { op: 'switchProject', id: 'b' })
  expect(there.activeProjectId).toBe('b')
  expect(there.viewport).toEqual(view(50))
  expect(there.projects[0].viewport).toEqual(view(10))
  const back = reduce(there, { op: 'switchProject', id: 'a' })
  expect(back.viewport).toEqual(view(10))
})

test('switching to the current or a missing project changes nothing', () => {
  const doc = twoProjects()
  expect(reduce(doc, { op: 'switchProject', id: 'a' })).toBe(doc)
  expect(reduce(doc, { op: 'switchProject', id: 'nope' })).toBe(doc)
})

test('adding a project puts it on screen', () => {
  const doc = reduce(twoProjects(), { op: 'addProject', project: project('c') })
  expect(doc.projects.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  expect(doc.activeProjectId).toBe('c')
})

test('patching changes only the name and folder of that project', () => {
  const doc = reduce(twoProjects(), { op: 'patchProject', id: 'b', patch: { name: 'New', folder: 'C:\\b' } })
  expect(doc.projects[1]).toMatchObject({ id: 'b', name: 'New', folder: 'C:\\b' })
  expect(doc.projects[0].name).toBe('A')
})

test('closing a project removes its nodes, and leaves the others alone', () => {
  const doc = reduce(twoProjects([terminal('in-a', 'a'), terminal('in-b', 'b')]), { op: 'removeProject', id: 'b', at: 1 })
  expect(doc.projects.map((p) => p.id)).toEqual(['a'])
  expect(doc.nodes.map((n) => n.id)).toEqual(['in-a'])
  expect(doc.activeProjectId).toBe('a')
})

test('closing the project on screen shows its neighbor and that view', () => {
  const doc = reduce(twoProjects(), { op: 'removeProject', id: 'a', at: 1 })
  expect(doc.activeProjectId).toBe('b')
  expect(doc.viewport).toEqual(view(50))
})

test('the last project cannot be closed', () => {
  const doc = { ...twoProjects([terminal('t', 'a')]), projects: [project('a')] }
  expect(reduce(doc, { op: 'removeProject', id: 'a', at: 1 })).toBe(doc)
})

test('closing a project hides it, and keeps its nodes', () => {
  const doc = reduce(twoProjects([terminal('in-a', 'a'), terminal('in-b', 'b')]), { op: 'closeProject', id: 'b', at: 7 })
  expect(doc.projects.find((p) => p.id === 'b')?.closedAt).toBe(7)
  expect(doc.nodes.map((n) => n.id)).toEqual(['in-a', 'in-b'])
  expect(doc.closed).toEqual([])
  expect(doc.activeProjectId).toBe('a')
})

test('closing the project on screen shows the next open one', () => {
  const doc: CanvasDoc = { ...twoProjects(), projects: [project('a'), { ...project('b'), closedAt: 1 }, project('c', view(70))] }
  const next = reduce(doc, { op: 'closeProject', id: 'a', at: 7 })
  expect(next.activeProjectId).toBe('c')
  expect(next.viewport).toEqual(view(70))
  expect(next.projects[0].viewport).toEqual(view(10))
})

test('the last open project cannot be closed, and a closed one cannot close again', () => {
  const doc: CanvasDoc = { ...twoProjects(), projects: [project('a'), { ...project('b'), closedAt: 1 }] }
  expect(reduce(doc, { op: 'closeProject', id: 'a', at: 7 })).toBe(doc)
  expect(reduce(doc, { op: 'closeProject', id: 'b', at: 7 })).toBe(doc)
  expect(reduce(doc, { op: 'closeProject', id: 'nope', at: 7 })).toBe(doc)
})

test('switching to a closed project reopens it with its view and nodes', () => {
  const start = reduce(twoProjects([terminal('in-b', 'b')]), { op: 'closeProject', id: 'b', at: 7 })
  const doc = reduce(start, { op: 'switchProject', id: 'b' })
  expect(doc.activeProjectId).toBe('b')
  expect(doc.projects.find((p) => p.id === 'b')?.closedAt).toBeUndefined()
  expect(doc.viewport).toEqual(view(50))
  expect(doc.nodes.map((n) => n.id)).toEqual(['in-b'])
})

test('a closed project can be deleted for good', () => {
  const start = reduce(twoProjects([terminal('in-b', 'b')]), { op: 'closeProject', id: 'b', at: 7 })
  const doc = reduce(start, { op: 'removeProject', id: 'b', at: 8 })
  expect(doc.projects.map((p) => p.id)).toEqual(['a'])
  expect(doc.nodes).toEqual([])
})

test('deleting the only open project brings a closed one back on screen', () => {
  const start = reduce(twoProjects(), { op: 'closeProject', id: 'b', at: 7 })
  const doc = reduce(start, { op: 'removeProject', id: 'a', at: 8 })
  expect(doc.activeProjectId).toBe('b')
  expect(doc.projects).toHaveLength(1)
  expect(doc.projects[0].closedAt).toBeUndefined()
})

test('closed conversations remember their project', () => {
  const claude: CanvasNode = { ...terminal('c', 'b'), kind: 'claude', sessionId: 's', transcriptPath: null, after: [] }
  const doc = reduce(twoProjects([claude]), { op: 'removeProject', id: 'b', at: 5 })
  expect(doc.closed[0]).toMatchObject({ sessionId: 's', projectId: 'b' })
})

test('only the project on screen is drawn, with no edge reaching outside it', () => {
  const doc: CanvasDoc = {
    ...twoProjects([terminal('a1', 'a'), terminal('a2', 'a'), terminal('b1', 'b')]),
    edges: [
      { id: 'inside', from: 'a1', to: 'a2', kind: 'link' },
      { id: 'across', from: 'a1', to: 'b1', kind: 'link' }
    ]
  }
  const flow = toFlow(doc, {})
  expect(flow.nodes.map((n) => n.id)).toEqual(['a1', 'a2'])
  expect(flow.edges.map((e) => e.id)).toEqual(['inside'])
})

test('the sidebar lists only the project on screen', () => {
  const tree = sessionTree(twoProjects([terminal('a1', 'a'), terminal('b1', 'b')]), '')
  expect(tree.total).toBe(1)
  expect(tree.ungrouped.map((s) => s.id)).toEqual(['a1'])
})

test('a window cannot be dropped into a group in another project', () => {
  const doc = twoProjects([group('hidden', 'b'), terminal('t', 'a')])
  const ops = dragOps(doc, [{ id: 't', abs: { x: 50, y: 50 }, rel: { x: 50, y: 50 } }])
  expect(ops.some((o) => o.op === 'setParent')).toBe(false)
})

test('a tab signals needs-you ahead of working, and only for its own sessions', () => {
  const doc = twoProjects([terminal('a1', 'a'), terminal('a2', 'a'), terminal('b1', 'b')])
  expect(projectSignal(doc, { a1: 'working', a2: 'needs-you' }, 'a')).toBe('needs-you')
  expect(projectSignal(doc, { a1: 'working' }, 'a')).toBe('working')
  expect(projectSignal(doc, { a1: 'idle' }, 'a')).toBeNull()
  expect(projectSignal(doc, { a1: 'needs-you' }, 'b')).toBeNull()
  expect(projectSessions(doc, 'a')).toEqual(['a1', 'a2'])
})

const version1 = {
  version: 1,
  nodes: [terminal('t')],
  edges: [],
  closed: [{ id: 'c', title: 'C', cwd: 'C:\\x', sessionId: 's', transcriptPath: null, closedAt: 1 }],
  viewport: view(7)
}

test('a save from before projects becomes one project, keeping everything', () => {
  const doc = migrate(version1)
  expect(doc.projects).toHaveLength(1)
  expect(doc.activeProjectId).toBe(doc.projects[0].id)
  expect(doc.viewport).toEqual(view(7))
  expect(doc.nodes[0]).toMatchObject({ id: 't', cwd: 'C:\\x', projectId: doc.projects[0].id })
  expect(doc.closed[0]).toMatchObject({ sessionId: 's', projectId: doc.projects[0].id })
})

test('a version 2 save loads as version 3 with every project open and nothing else changed', () => {
  const old = { ...twoProjects([terminal('t', 'a')]), version: 2 }
  const doc = migrate(old)
  expect(doc.version).toBe(3)
  expect(doc.projects.every((p) => p.closedAt === undefined)).toBe(true)
  expect(doc.nodes).toEqual(old.nodes)
  expect(doc.viewport).toEqual(old.viewport)
})

test('a version 1 save comes all the way up', () => {
  expect(migrate(version1).version).toBe(3)
})

test('a closed project and a window font size survive a save and load', () => {
  const doc = reduce(twoProjects([terminal('t', 'b', { fontSize: 16 })]), { op: 'closeProject', id: 'b', at: 7 })
  const loaded = migrate(JSON.parse(JSON.stringify(doc)))
  expect(loaded.projects.find((p) => p.id === 'b')?.closedAt).toBe(7)
  expect(loaded.nodes[0].fontSize).toBe(16)
})

test('a save whose active project is closed opens that project rather than hiding the screen', () => {
  const closed = { ...twoProjects(), projects: [{ ...project('a'), closedAt: 3 }, project('b')] }
  const doc = migrate(JSON.parse(JSON.stringify(closed)))
  expect(doc.activeProjectId).toBe('a')
  expect(doc.projects[0].closedAt).toBeUndefined()
})

test('a save with an unknown active project falls back to an open one', () => {
  const lost = { ...twoProjects(), activeProjectId: 'gone', projects: [{ ...project('a'), closedAt: 3 }, project('b')] }
  expect(migrate(JSON.parse(JSON.stringify(lost))).activeProjectId).toBe('b')
})

test('a project with a bad closed time is refused', () => {
  expect(() => migrate({ ...twoProjects(), projects: [{ ...project('a'), closedAt: 'soon' }] })).toThrow(/projects/)
})

test('a migrated save still refuses bad nodes rather than trusting them', () => {
  expect(() => migrate({ ...version1, nodes: [{ id: 'broken' }] })).toThrow(/invalid nodes/)
  expect(() => migrate({ ...version1, nodes: 'nope' })).toThrow(/invalid nodes/)
})

test('a save with no valid projects is refused', () => {
  const good = twoProjects()
  expect(() => migrate({ ...good, projects: [] })).toThrow(/projects/)
  expect(() => migrate({ ...good, projects: [{ id: 'x' }] })).toThrow(/projects/)
})

test('an unknown active project falls back, and a node in no project is brought back into view', () => {
  const doc = migrate({ ...twoProjects([terminal('lost', 'gone')]), activeProjectId: 'gone' })
  expect(doc.activeProjectId).toBe('a')
  expect(doc.nodes[0].projectId).toBe('a')
})

