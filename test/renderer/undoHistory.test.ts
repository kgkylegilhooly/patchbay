import { describe, expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { EMPTY_HISTORY, diffLayout, entryFor, recordEntry, stepBack, stepForward, type HistoryEntry } from '../../src/renderer/undoHistory'
import type { CanvasDoc, CanvasNode, CanvasOp } from '../../src/shared/model'

const box = { x: 0, y: 0, width: 100, height: 100, parentId: null as string | null, projectId: 'a' }
const terminal = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ ...box, id, title: id, kind: 'terminal', cwd: 'C:\\x', ...over } as CanvasNode)
const claude = (id: string): CanvasNode => ({ ...box, id, title: id, kind: 'claude', cwd: 'C:\\x', sessionId: 's', transcriptPath: null, after: [] })
const sticky = (id: string): CanvasNode => ({ ...box, id, title: 'Note', kind: 'sticky', text: 'hello' })
const group = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({ ...box, id, title: id, kind: 'group', worktree: null, width: 600, height: 600, ...over } as CanvasNode)

const docOf = (nodes: CanvasNode[]): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'a', name: 'A', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'a',
  nodes,
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
})

const run = (doc: CanvasDoc, ops: CanvasOp[]): CanvasDoc => ops.reduce(reduce, doc)
const undo = (doc: CanvasDoc, entry: HistoryEntry): CanvasDoc => reduce(doc, { op: 'restoreLayout', ...entry.undo })
const redo = (doc: CanvasDoc, entry: HistoryEntry): CanvasDoc => reduce(doc, { op: 'restoreLayout', ...entry.redo })

/** Checks that going back gives the original layout and going forward gives the result. */
function roundTrip(start: CanvasDoc, ops: CanvasOp[]): HistoryEntry {
  const entry = entryFor(start, 'x', ops)!
  expect(entry).not.toBeNull()
  const after = run(start, ops)
  const back = undo(after, entry)
  expect(back.nodes).toEqual(start.nodes)
  expect(redo(back, entry).nodes).toEqual(after.nodes)
  return entry
}

describe('undoing layout', () => {
  test('a move', () => {
    roundTrip(docOf([terminal('t')]), [{ op: 'patchNode', id: 't', patch: { x: 50, y: 60 } }])
  })

  test('a resize', () => {
    roundTrip(docOf([terminal('t')]), [{ op: 'patchNode', id: 't', patch: { width: 300, height: 400 } }])
  })

  test('a rename', () => {
    roundTrip(docOf([terminal('t')]), [{ op: 'patchNode', id: 't', patch: { title: 'New name' } }])
  })

  test('tidying', () => {
    roundTrip(docOf([terminal('a'), terminal('b', { x: 900 }), terminal('c', { y: 700 })]), [{ op: 'arrange', ids: ['a', 'b', 'c'], layout: 'grid' }])
  })

  test('grouping nodes', () => {
    const start = docOf([terminal('a', { x: 100, y: 100 }), terminal('b', { x: 300, y: 100 })])
    const entry = roundTrip(start, [{ op: 'addNode', node: group('g', { x: 50, y: 20 }) }, { op: 'setParent', ids: ['a', 'b'], parentId: 'g' }])
    expect(entry.undo.remove).toEqual(['g'])
  })

  test('moving a child refits its group, and undo puts the group back too', () => {
    const start = docOf([group('g'), terminal('t', { parentId: 'g', x: 24, y: 64 })])
    roundTrip(start, [{ op: 'patchNode', id: 't', patch: { x: 1000, y: 1000 } }])
  })

  test('adding a note', () => {
    const entry = roundTrip(docOf([]), [{ op: 'addNode', node: sticky('n') }])
    expect(entry.undo.remove).toEqual(['n'])
  })

  test('deleting a note brings back its text', () => {
    const start = docOf([sticky('n')])
    const entry = roundTrip(start, [{ op: 'removeNodes', ids: ['n'], at: 1 }])
    const after = run(start, [{ op: 'removeNodes', ids: ['n'], at: 1 }])
    expect((undo(after, entry).nodes[0] as { text: string }).text).toBe('hello')
  })

  test('deleting a note brings back its links', () => {
    const start: CanvasDoc = { ...docOf([sticky('n'), terminal('t')]), edges: [{ id: 'e', from: 'n', to: 't', kind: 'link' }] }
    const entry = entryFor(start, 'x', [{ op: 'removeNodes', ids: ['n'], at: 1 }])!
    const after = run(start, [{ op: 'removeNodes', ids: ['n'], at: 1 }])
    expect(after.edges).toEqual([])
    expect(undo(after, entry).edges.map((e) => e.id)).toEqual(['e'])
  })

  test('ungrouping brings the group back around its children', () => {
    const start = docOf([group('g', { x: 500, y: 500 }), terminal('t', { parentId: 'g', x: 24, y: 64 })])
    roundTrip(start, [{ op: 'removeNodes', ids: ['g'], at: 1 }])
  })

  test('nothing changing records nothing', () => {
    const doc = docOf([terminal('t')])
    expect(entryFor(doc, 'x', [{ op: 'patchNode', id: 't', patch: { x: 0 } }])).toBeNull()
    expect(diffLayout(doc, doc)).toBeNull()
  })

  test('a change that is not layout records nothing', () => {
    const doc = docOf([sticky('n')])
    expect(entryFor(doc, 'x', [{ op: 'patchNode', id: 'n', patch: { fontSize: 15 } }])).toBeNull()
  })
})

describe('undo never touches a process', () => {
  test('restoring can neither remove nor add a session', () => {
    const doc = docOf([terminal('t'), claude('c')])
    const removed = reduce(doc, { op: 'restoreLayout', patches: [], add: [terminal('new')], remove: ['t', 'c'], edges: [] })
    expect(removed.nodes.map((n) => n.id)).toEqual(['t', 'c'])
    expect(removed.closed).toEqual([])
  })

  test('a closed session is not part of any undo', () => {
    const doc = docOf([terminal('t')])
    const closing = entryFor(doc, 'x', [{ op: 'removeNodes', ids: ['t'], at: 1 }])
    expect(closing).toBeNull()
  })

  test('a session closed since the move is skipped, and stays closed', () => {
    const start = docOf([terminal('t'), terminal('other')])
    const ops: CanvasOp[] = [{ op: 'patchNode', id: 't', patch: { x: 50 } }, { op: 'patchNode', id: 'other', patch: { x: 70 } }]
    const entry = entryFor(start, 'x', ops)!
    const closedSince = run(run(start, ops), [{ op: 'removeNodes', ids: ['t'], at: 1 }])
    const back = undo(closedSince, entry)
    expect(back.nodes.map((n) => [n.id, n.x])).toEqual([['other', 0]])
  })

  test('a window whose old group has gone stays where it is', () => {
    const start = docOf([group('g'), terminal('t', { parentId: 'g', x: 24, y: 64 })])
    const moveOut: CanvasOp[] = [{ op: 'setParent', ids: ['t'], parentId: null }]
    const entry = entryFor(start, 'x', moveOut)!
    const groupGone = run(run(start, moveOut), [{ op: 'removeNodes', ids: ['g'], at: 1 }])
    const back = undo(groupGone, entry)
    expect(back.nodes.find((n) => n.id === 't')?.parentId).toBeNull()
  })
})

describe('the undo stack', () => {
  const entry = (label: string): HistoryEntry => ({ label, undo: { patches: [], add: [], remove: [], edges: [] }, redo: { patches: [], add: [], remove: [], edges: [] } })

  test('steps back and forward in order', () => {
    const history = recordEntry(recordEntry(EMPTY_HISTORY, entry('one')), entry('two'))
    const back = stepBack(history)!
    expect(back.entry.label).toBe('two')
    const further = stepBack(back.history)!
    expect(further.entry.label).toBe('one')
    expect(stepBack(further.history)).toBeNull()
    const forward = stepForward(further.history)!
    expect(forward.entry.label).toBe('one')
    expect(stepForward(forward.history)?.entry.label).toBe('two')
  })

  test('with nothing to do it says so', () => {
    expect(stepBack(EMPTY_HISTORY)).toBeNull()
    expect(stepForward(EMPTY_HISTORY)).toBeNull()
  })

  test('a new change clears what could be redone', () => {
    const history = stepBack(recordEntry(EMPTY_HISTORY, entry('one')))!.history
    expect(history.future).toHaveLength(1)
    expect(recordEntry(history, entry('two')).future).toEqual([])
  })

  test('keeps a limited number of steps', () => {
    let history = EMPTY_HISTORY
    for (let i = 0; i < 150; i++) history = recordEntry(history, entry(String(i)))
    expect(history.past).toHaveLength(100)
    expect(history.past[99].label).toBe('149')
  })
})
