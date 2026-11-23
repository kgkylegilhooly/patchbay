import { expect, test } from 'vitest'
import { keepSame, sameItems } from '../../src/renderer/sameList'

test('the same items in the same order are the same list', () => {
  expect(sameItems(['a', 'b'], ['a', 'b'])).toBe(true)
  expect(sameItems([], [])).toBe(true)
  expect(sameItems(['a', 'b'], ['b', 'a'])).toBe(false)
  expect(sameItems(['a'], ['a', 'b'])).toBe(false)
})

test('a selection worked out again with nothing new keeps the list from before', () => {
  const before = ['a', 'b']
  expect(keepSame(before, ['a', 'b'])).toBe(before)
  const changed = ['a', 'c']
  expect(keepSame(before, changed)).toBe(changed)
  const first = ['a']
  expect(keepSame(undefined, first)).toBe(first)
})
