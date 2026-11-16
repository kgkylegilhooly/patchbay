import { describe, expect, test } from 'vitest'
import { sameContent, shareDoc, shareEdges } from '../../src/renderer/docShare'
import type { CanvasDoc } from '../../src/shared/model'

const doc = (text: string, extra: Partial<CanvasDoc> = {}): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'a', kind: 'sticky', title: 'A', text, x: 0, y: 0, width: 1, height: 1, parentId: null },
    { id: 'b', kind: 'terminal', title: 'B', cwd: 'c', x: 0, y: 0, width: 1, height: 1, parentId: null }
  ],
  edges: [{ id: 'e', from: 'a', to: 'b', kind: 'link' }],
  closed: [],
  ...extra
})

// Each doc is built afresh, as one that came across from main is: equal content, different objects.
describe('sharing a new doc with the one before', () => {
  test('a node that did not change stays the same object, and one that did is the new one', () => {
    const before = doc('x')
    const after = shareDoc(before, doc('y'))
    expect(after.nodes[1]).toBe(before.nodes[1])
    expect(after.nodes[0]).not.toBe(before.nodes[0])
    expect(after.nodes[0]).toMatchObject({ text: 'y' })
    expect(after.edges).toBe(before.edges)
    expect(after.projects).toBe(before.projects)
  })

  test('a doc with nothing changed is the doc from before', () => {
    const before = doc('x')
    expect(shareDoc(before, doc('x'))).toBe(before)
  })

  test('added, removed and reordered nodes come through as they are', () => {
    const before = doc('x')
    const next = doc('x')
    next.nodes = [next.nodes[1], next.nodes[0], { id: 'c', kind: 'sticky', title: 'C', text: '', x: 0, y: 0, width: 1, height: 1, parentId: null }]
    const after = shareDoc(before, next)
    expect(after.nodes.map((n) => n.id)).toEqual(['b', 'a', 'c'])
    expect(after.nodes[0]).toBe(before.nodes[1])
    expect(shareDoc(before, { ...doc('x'), nodes: [doc('x').nodes[0]] }).nodes).toHaveLength(1)
  })

  test('with nothing before, the new doc is used as it is', () => {
    const next = doc('x')
    expect(shareDoc(null, next)).toBe(next)
  })
})

test('content is compared deeply, arrays and objects alike', () => {
  expect(sameContent({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
  expect(sameContent({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false)
  expect(sameContent({ a: 1 }, { a: 1, b: undefined })).toBe(false)
  expect(sameContent([1], { 0: 1 })).toBe(false)
  expect(sameContent(null, {})).toBe(false)
})

test('cables keep their objects when unchanged, and the person\'s selection carries over', () => {
  const edge = (id: string) => ({ id, source: 'a', target: 'b', type: 'cable', data: { kind: 'link' as const } })
  const prev = [{ ...edge('e'), selected: true }, edge('f')]
  const next = shareEdges(prev, [edge('e'), edge('f')])
  expect(next).toBe(prev)
  const changed = shareEdges(prev, [edge('e'), { ...edge('f'), target: 'c' }])
  expect(changed[0]).toBe(prev[0])
  expect(changed[1]).toMatchObject({ target: 'c' })
})
