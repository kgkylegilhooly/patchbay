import { expect, test } from 'vitest'
import { addWindow, closePane, initialLayout, leaves, MIN_RATIO, paneAt, prune, setRatio, showIn, splitPane, type Pane } from '../../src/renderer/focusLayout'

const ids = (p: Pane) => leaves(p).map((l) => l.nodeId)

test('a first layout fits the windows: one, two side by side, or a grid', () => {
  expect(initialLayout([])).toEqual({ type: 'leaf', nodeId: null })
  expect(initialLayout(['a'])).toEqual({ type: 'leaf', nodeId: 'a' })
  expect(initialLayout(['a', 'b'])).toMatchObject({ type: 'split', dir: 'row' })
  expect(ids(initialLayout(['a', 'b', 'c']))).toEqual(['a', 'b', 'c'])
  expect(ids(initialLayout(['a', 'b', 'c', 'd', 'e']))).toEqual(['a', 'b', 'c', 'd'])
})

test('splitting a pane keeps its window and adds an empty half, in either direction', () => {
  const two = splitPane(initialLayout(['a']), [], 'row')
  expect(two).toMatchObject({ type: 'split', dir: 'row', a: { nodeId: 'a' }, b: { nodeId: null } })
  const three = splitPane(two, ['b'], 'column', 'c')
  expect(paneAt(three, ['b'])).toMatchObject({ type: 'split', dir: 'column' })
  expect(ids(three)).toEqual(['a', null, 'c'])
})

test('closing a pane gives its space to its neighbour, and the last pane only empties', () => {
  const l = initialLayout(['a', 'b', 'c'])
  expect(ids(closePane(l, ['b', 'a']))).toEqual(['a', 'c'])
  expect(ids(closePane(l, ['a']))).toEqual(['b', 'c'])
  expect(closePane(initialLayout(['a']), [])).toEqual({ type: 'leaf', nodeId: null })
})

test('a window shows in one pane at a time', () => {
  const l = showIn(initialLayout(['a', 'b']), ['b'], 'a')
  expect(ids(l)).toEqual([null, 'a'])
})

test('a divider stays away from the edges', () => {
  const l = initialLayout(['a', 'b'])
  expect(setRatio(l, [], 0)).toMatchObject({ ratio: MIN_RATIO })
  expect(setRatio(l, [], 0.7)).toMatchObject({ ratio: 0.7 })
  expect(setRatio(l, [], 2)).toMatchObject({ ratio: 1 - MIN_RATIO })
})

test('a saved layout drops windows that are gone, and a broken one is refused', () => {
  const saved = JSON.parse(JSON.stringify(initialLayout(['a', 'gone'])))
  expect(ids(prune(saved, (id) => id === 'a')!)).toEqual(['a', null])
  expect(prune({ type: 'split', dir: 'diagonal' }, () => true)).toBeNull()
  expect(prune('nonsense', () => true)).toBeNull()
  expect(prune({ type: 'split', dir: 'row', ratio: 'x', a: { type: 'leaf', nodeId: 'a' }, b: { type: 'leaf', nodeId: null } }, () => true)).toMatchObject({ ratio: 0.5 })
})

test('adding a window fills an empty pane first, then splits', () => {
  expect(ids(addWindow(splitPane(initialLayout(['a']), [], 'row'), 'b'))).toEqual(['a', 'b'])
  expect(ids(addWindow(initialLayout(['a']), 'b'))).toEqual(['a', 'b'])
  const same = initialLayout(['a'])
  expect(addWindow(same, 'a')).toBe(same)
})
