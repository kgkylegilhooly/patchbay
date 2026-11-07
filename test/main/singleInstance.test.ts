import { expect, test } from 'vitest'
import { decideInstance } from '../../src/main/lifecycle'

test('the first launch runs', () => {
  expect(decideInstance(true)).toBe('run')
})

test('a second launch focuses the first and quits', () => {
  expect(decideInstance(false)).toBe('focus-and-quit')
})
