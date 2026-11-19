import { describe, expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { archiveRefusal, inArchivedProject, moveProjectBefore, orderProjects, removeRefusal, tabStep } from '../../src/core/canvas/projectOps'
import { migrate } from '../../src/core/persist/docStore'
import { planRestore } from '../../src/main/lifecycle'
import { entryFor } from '../../src/renderer/undoHistory'
import { closedProjects } from '../../src/renderer/sidebarView'
import type { CanvasDoc, CanvasNode, ClaudeNode, Project } from '../../src/shared/model'

const view = { x: 0, y: 0, zoom: 1 }
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id.toUpperCase(), folder: '', viewport: view, ...over })
const agent = (id: string, projectId: string, over: Partial<ClaudeNode> = {}): ClaudeNode => ({
  id,
  kind: 'claude',
  title: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  parentId: null,
  cwd: 'C:\\x',
  sessionId: `session-${id}`,
  transcriptPath: null,
  after: [],
  projectId,
  ...over
})
const note = (id: string, projectId: string): CanvasNode => ({
  id,
  kind: 'sticky',
  title: id,
  text: 'kept',
  x: 0,
  y: 0,
  width: 50,
  height: 50,
  parentId: null,
  projectId
})

const doc = (projects: Project[], nodes: CanvasNode[] = [], active = projects[0].id): CanvasDoc => ({
  version: 3,
  projects,
  activeProjectId: active,
  nodes,
  edges: [],
  closed: [],
  viewport: view
})
const ids = (d: CanvasDoc): string[] => d.projects.map((p) => p.id)

describe('moving tabs', () => {
  test('a project moves to just before another, or to the end', () => {
    const d = doc([project('a'), project('b'), project('c')])
    expect(ids(reduce(d, { op: 'moveProject', id: 'c', before: 'a' }))).toEqual(['c', 'a', 'b'])
    expect(ids(reduce(d, { op: 'moveProject', id: 'a', before: null }))).toEqual(['b', 'c', 'a'])
    expect(ids(reduce(d, { op: 'moveProject', id: 'a', before: 'c' }))).toEqual(['b', 'a', 'c'])
  })

  test('a move that changes nothing, or names a project that is not there, returns the same doc', () => {
    const d = doc([project('a'), project('b')])
    expect(reduce(d, { op: 'moveProject', id: 'a', before: 'b' })).toBe(d)
    expect(reduce(d, { op: 'moveProject', id: 'a', before: 'a' })).toBe(d)
    expect(reduce(d, { op: 'moveProject', id: 'x', before: null })).toBe(d)
    expect(reduce(d, { op: 'moveProject', id: 'a', before: 'x' })).toBe(d)
  })

  test('Move left and Move right step over closed projects, among the open tabs only', () => {
    const projects = [project('a'), project('hidden', { closedAt: 1 }), project('b'), project('c')]
    expect(tabStep(projects, 'b', -1)).toEqual({ before: 'a' })
    expect(tabStep(projects, 'a', 1)).toEqual({ before: 'c' })
    expect(tabStep(projects, 'b', 1)).toEqual({ before: null })
    expect(tabStep(projects, 'a', -1)).toBeUndefined()
    expect(tabStep(projects, 'c', 1)).toBeUndefined()
    const moved = moveProjectBefore(projects, 'a', 'c')
    expect(moved.filter((p) => p.closedAt === undefined).map((p) => p.id)).toEqual(['b', 'a', 'c'])
  })

  test('the order persists through a save and load', () => {
    const moved = reduce(doc([project('a'), project('b')]), { op: 'moveProject', id: 'b', before: 'a' })
    expect(ids(migrate(JSON.parse(JSON.stringify(moved))))).toEqual(['b', 'a'])
  })

  test('a move is undoable and redoable through restoreLayout', () => {
    const d = doc([project('a'), project('b'), project('c')])
    const entry = entryFor(d, 'move project tab', [{ op: 'moveProject', id: 'c', before: 'a' }])!
    expect(entry).not.toBeNull()
    const moved = reduce(d, { op: 'moveProject', id: 'c', before: 'a' })
    const undone = reduce(moved, { op: 'restoreLayout', ...entry.undo })
    expect(ids(undone)).toEqual(['a', 'b', 'c'])
    expect(ids(reduce(undone, { op: 'restoreLayout', ...entry.redo }))).toEqual(['c', 'a', 'b'])
  })

  test('putting an order back keeps projects it does not name, after the rest', () => {
    const projects = [project('a'), project('b'), project('new')]
    expect(orderProjects(projects, ['b', 'a']).map((p) => p.id)).toEqual(['b', 'a', 'new'])
  })
})

describe('archiving', () => {
  test('keeps every node, closes it, and marks it archived', () => {
    const d = doc([project('a'), project('b')], [agent('x', 'b'), note('n', 'b')])
    const after = reduce(d, { op: 'archiveProject', id: 'b', at: 500 })
    const b = after.projects.find((p) => p.id === 'b')!
    expect(b.archivedAt).toBe(500)
    expect(b.closedAt).toBe(500)
    expect(after.nodes).toEqual(d.nodes)
  })

  test('a closed project keeps when it was first closed', () => {
    const after = reduce(doc([project('a'), project('b', { closedAt: 7 })]), { op: 'archiveProject', id: 'b', at: 500 })
    expect(after.projects[1]).toMatchObject({ closedAt: 7, archivedAt: 500 })
  })

  test('archiving the project on screen shows the next open one, or brings a closed one back', () => {
    const d = doc([project('a'), project('b')])
    expect(reduce(d, { op: 'archiveProject', id: 'a', at: 1 }).activeProjectId).toBe('b')
    const onlyClosedLeft = doc([project('a'), project('b', { closedAt: 1 })])
    const after = reduce(onlyClosedLeft, { op: 'archiveProject', id: 'a', at: 2 })
    expect(after.activeProjectId).toBe('b')
    expect(after.projects.find((p) => p.id === 'b')!.closedAt).toBeUndefined()
  })

  test('the last project that is not archived cannot be archived or deleted', () => {
    const d = doc([project('a'), project('old', { closedAt: 1, archivedAt: 1 })])
    expect(archiveRefusal(d, 'a')).toMatch(/only project that isn't archived/)
    expect(reduce(d, { op: 'archiveProject', id: 'a', at: 5 })).toBe(d)
    expect(removeRefusal(d, 'a')).toMatch(/only project that isn't archived/)
    expect(reduce(d, { op: 'removeProject', id: 'a', at: 5 })).toBe(d)
    // The archived one itself can still be deleted.
    expect(removeRefusal(d, 'old')).toBeNull()
    expect(ids(reduce(d, { op: 'removeProject', id: 'old', at: 5 }))).toEqual(['a'])
  })

  test('an archived project cannot be shown or archived again', () => {
    const d = reduce(doc([project('a'), project('b')]), { op: 'archiveProject', id: 'b', at: 1 })
    expect(reduce(d, { op: 'switchProject', id: 'b' })).toBe(d)
    expect(reduce(d, { op: 'archiveProject', id: 'b', at: 2 })).toBe(d)
    expect(reduce(d, { op: 'closeProject', id: 'b', at: 2 })).toBe(d)
  })

  test('removing the project on screen never lands on an archived one', () => {
    const d = doc([project('a'), project('arch', { closedAt: 1, archivedAt: 1 }), project('c', { closedAt: 1 })])
    const after = reduce(d, { op: 'removeProject', id: 'a', at: 2 })
    expect(after.activeProjectId).toBe('c')
  })

  test('unarchiving brings it back closed, or open and on screen', () => {
    const d = reduce(doc([project('a'), project('b')], [agent('x', 'b')]), { op: 'archiveProject', id: 'b', at: 1 })
    const closed = reduce(d, { op: 'unarchiveProject', id: 'b', open: false })
    expect(closed.projects[1].archivedAt).toBeUndefined()
    expect(closed.projects[1].closedAt).toBe(1)
    expect(closed.activeProjectId).toBe('a')
    const open = reduce(d, { op: 'unarchiveProject', id: 'b', open: true })
    expect(open.activeProjectId).toBe('b')
    expect(open.projects[1].closedAt).toBeUndefined()
    expect(reduce(closed, { op: 'unarchiveProject', id: 'b', open: false })).toBe(closed)
  })

  test("an archived project's sessions are left out of the launch restore, and back once it's unarchived", () => {
    const d = reduce(doc([project('a'), project('b')], [agent('keep', 'a'), agent('away', 'b'), agent('held', 'b', { after: ['away'] })]), {
      op: 'archiveProject',
      id: 'b',
      at: 1
    })
    const plan = planRestore(d)
    expect(plan.claude).toEqual(['keep'])
    expect(plan.held).toEqual([])
    expect(planRestore(reduce(d, { op: 'unarchiveProject', id: 'b', open: false })).claude).toEqual(['keep', 'away'])
  })

  test('it is left out of the closed list, which still lists plain closed projects', () => {
    const d = doc([project('a'), project('closed', { closedAt: 5 }), project('arch', { closedAt: 1, archivedAt: 9 })])
    expect(closedProjects(d).map((p) => p.id)).toEqual(['closed'])
  })

  test('a node knows when its project is archived', () => {
    const d = doc([project('a'), project('arch', { closedAt: 1, archivedAt: 1 })])
    expect(inArchivedProject(d, { projectId: 'arch' })).toBe(true)
    expect(inArchivedProject(d, { projectId: 'a' })).toBe(false)
    expect(inArchivedProject(d, {})).toBe(false)
  })
})

describe('loading', () => {
  const saved = (projects: unknown[], active = 'a') => ({ version: 3, projects, activeProjectId: active, nodes: [], edges: [], closed: [], viewport: view })

  test('a doc from before archiving loads unchanged', () => {
    const loaded = migrate(saved([project('a'), project('b', { closedAt: 3 })]))
    expect(loaded.projects).toEqual([project('a'), project('b', { closedAt: 3 })])
  })

  test('an archive mark survives a save and load', () => {
    const loaded = migrate(JSON.parse(JSON.stringify(saved([project('a'), project('b', { closedAt: 3, archivedAt: 4 })]))))
    expect(loaded.projects[1]).toMatchObject({ closedAt: 3, archivedAt: 4 })
  })

  test('a damaged archive mark is dropped, and the project loads as it was', () => {
    for (const bad of ['yesterday', null, Number.NaN, {}, true]) {
      const loaded = migrate(saved([project('a'), { ...project('b', { closedAt: 3 }), archivedAt: bad }]))
      expect(loaded.projects[1]).toEqual(project('b', { closedAt: 3 }))
    }
  })

  test('an archived project with no closing time is closed too', () => {
    const loaded = migrate(saved([project('a'), { ...project('b'), archivedAt: 8 }]))
    expect(loaded.projects[1]).toMatchObject({ closedAt: 8, archivedAt: 8 })
  })

  test('the project on screen is never archived, whatever the file says', () => {
    const loaded = migrate(saved([project('a', { closedAt: 1, archivedAt: 2 }), project('b')]))
    expect(loaded.activeProjectId).toBe('a')
    expect(loaded.projects[0].archivedAt).toBeUndefined()
    expect(loaded.projects[0].closedAt).toBeUndefined()
  })
})

test('Next needing you skips an archived project', async () => {
  const { needsYouQueue } = await import('../../src/renderer/needsYou')
  const d = doc([project('a'), project('arch', { closedAt: 1, archivedAt: 1 }), project('shut', { closedAt: 1 })], [agent('here', 'a'), agent('gone', 'arch'), agent('closed', 'shut')])
  const statuses = { here: 'needs-you', gone: 'needs-you', closed: 'exited' } as const
  const queue = needsYouQueue(d, { ...statuses }, ['gone', 'closed'], {}, true)
  expect(queue.map((e) => e.id)).toEqual(['here', 'closed'])
})
