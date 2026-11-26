import { expect, test } from 'vitest'
import { KEEP_PROMPTS, promptLabel, remembered } from '../../src/renderer/recentPrompts'

// F39: a brief retyped into each new agent ("run the tests and fix what fails") is one pick away instead.
test('the newest prompt first, once each, trimmed, and only so many kept', () => {
  let list: string[] = []
  list = remembered(list, '  Run the tests and fix what fails.  ')
  list = remembered(list, 'Review the open PR')
  list = remembered(list, 'Run the tests and fix what fails.')
  expect(list).toEqual(['Run the tests and fix what fails.', 'Review the open PR'])
  expect(remembered(list, '   ')).toBe(list)
  for (let i = 0; i < 40; i++) list = remembered(list, `task ${i}`)
  expect(list).toHaveLength(KEEP_PROMPTS)
  expect(list[0]).toBe('task 39')
})

test('a prompt is listed by its first line that says something, cut short', () => {
  expect(promptLabel('\n\n  Fix the login bug\nthen add a test')).toBe('Fix the login bug')
  expect(promptLabel('word '.repeat(30))).toMatch(/^(word ){10,}word…$/)
  expect(promptLabel('word '.repeat(30)).length).toBeLessThanOrEqual(61)
})
