import { expect, test } from 'vitest'
import { pinnedNoteText, worthPinning } from '../../src/renderer/pinOutput'

const at = new Date(2026, 10, 24, 15, 30)

test('the note says where the output came from and holds it as a code block, trailing blank lines trimmed', () => {
  const text = pinnedNoteText('npm test', 'FAIL src/parser.test.ts\r\n  expected 2, got 1\r\n\r\n', at)
  expect(text.startsWith('From **npm test**, ')).toBe(true)
  expect(text).toContain('\n\n```\nFAIL src/parser.test.ts\n  expected 2, got 1\n```\n')
})

test('backticks in the output never end the block early, and a title cannot add formatting', () => {
  const text = pinnedNoteText('*Dev* `shell`', 'run ```danger``` and ````more````', at)
  expect(text.startsWith('From **Dev shell**, ')).toBe(true)
  expect(text).toContain('\n`````\nrun ```danger``` and ````more````\n`````\n')
})

test('only a selection with something in it is worth pinning', () => {
  expect(worthPinning('x')).toBe(true)
  expect(worthPinning('  \n ')).toBe(false)
  expect(worthPinning('')).toBe(false)
  expect(worthPinning(undefined)).toBe(false)
})
