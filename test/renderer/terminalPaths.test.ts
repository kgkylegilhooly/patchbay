import { expect, test } from 'vitest'
import { findTerminalPathMatches, findTerminalPaths } from '../../src/renderer/terminalPaths'

test.each([
  ['see C:\\Program Files\\app\\a.ts:12', 'C:\\Program Files\\app\\a.ts'],
  ['failed at src/core/x.ts:3:9', 'src/core/x.ts'],
  ['"docs/my notes.md"', 'docs/my notes.md']
])('findTerminalPaths in %s', (line, expected) => {
  expect(findTerminalPaths(line)).toEqual([expected])
})

test.each([
  ['./run.sh', './run.sh'],
  ['../up/a.txt.', '../up/a.txt'],
  ['(src\\win\\style.css)', 'src\\win\\style.css'],
  ['C:/Users/me/a.log: bad', 'C:/Users/me/a.log'],
  ["'C:\\a b\\c d.txt'", 'C:\\a b\\c d.txt']
])('more forms: %s', (line, expected) => {
  expect(findTerminalPaths(line)).toEqual([expected])
})

test.each([
  ['visit https://example.com/docs/page.html now'],
  ['and/or either/or'],
  ['3/4 done, 12/31/2026'],
  ['plain words only.']
])('finds no path in %s', (line) => {
  expect(findTerminalPaths(line)).toEqual([])
})

test('finds two paths on one line', () => {
  expect(findTerminalPaths('moved src/a.ts to src/b.ts')).toEqual(['src/a.ts', 'src/b.ts'])
})

test('matches give the range of the path, including its line suffix', () => {
  const line = 'failed at src/core/x.ts:3:9 ok'
  const [m] = findTerminalPathMatches(line)
  expect(m.path).toBe('src/core/x.ts')
  expect(line.slice(m.start, m.end)).toBe('src/core/x.ts:3:9')
})
