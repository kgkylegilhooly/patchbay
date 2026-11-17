import { expect, test } from 'vitest'
import { findTerminalPathMatches, findTerminalPaths, linkKind } from '../../src/renderer/terminalPaths'

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

test.each([
  ['Read /c/Code/repos/app/README.md', '/c/Code/repos/app/README.md'],
  ['cd /c/Users/me/projects', '/c/Users/me/projects'],
  ['Wrote ~/notes/todo.md.', '~/notes/todo.md'],
  ['log at /tmp/build/out.log:4', '/tmp/build/out.log']
])('Git Bash and home paths keep their start: %s', (line, expected) => {
  expect(findTerminalPaths(line)).toEqual([expected])
})

test.each([['type /help for help'], ['run /compact now'], ['a 1/2 cup']])('a slash command or fraction is not a path: %s', (line) => {
  expect(findTerminalPaths(line)).toEqual([])
})

test('a file:// link is a path, and web links stay out', () => {
  expect(findTerminalPaths('see file:///C:/Code/app/src/a.ts for it')).toEqual(['file:///C:/Code/app/src/a.ts'])
  expect(findTerminalPaths('file:///C:/my%20folder/notes%202.md.')).toEqual(['file:///C:/my%20folder/notes%202.md'])
  expect(findTerminalPaths('https://example.com/src/a.ts')).toEqual([])
})

test('a link is a web link if it has a scheme other than file:', () => {
  expect(linkKind('https://example.com')).toBe('web')
  expect(linkKind('mailto:me@example.com')).toBe('web')
  expect(linkKind('file:///C:/a.ts')).toBe('path')
  expect(linkKind('C:\a.ts')).toBe('path')
  expect(linkKind('src/a.ts:3:4')).toBe('path')
})
