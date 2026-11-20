import { expect, test } from 'vitest'
import { shortPath } from '../../src/renderer/shortPath'

test('a path inside the root is shown from the root', () => {
  expect(shortPath('C:\\Code\\repos\\patchbay\\src\\renderer', 'C:\\Code\\repos\\patchbay')).toBe('src\\renderer')
  expect(shortPath('/home/sam/app/web', '/home/sam/app/')).toBe('web')
})

test('the root itself is shown by its folder name', () => {
  expect(shortPath('C:\\Code\\repos\\patchbay', 'C:\\Code\\repos\\patchbay\\')).toBe('patchbay')
})

test('the root matches without regard to case or slash direction', () => {
  expect(shortPath('c:\\code\\Repos\\patchbay\\docs', 'C:/Code/repos/patchbay')).toBe('docs')
})

test('a folder that only starts with the same letters is not inside the root', () => {
  expect(shortPath('C:\\Code\\repos\\patchbay-worktrees\\try-a', 'C:\\Code\\repos\\patchbay')).toBe('…\\patchbay-worktrees\\try-a')
})

test('a drive or filesystem root is never used as the root, so the drive is kept', () => {
  expect(shortPath('C:\\Users\\me', 'C:\\')).toBe('C:\\Users\\me')
  expect(shortPath('C:\\Users\\me\\x', 'C:\\')).toBe('…\\me\\x')
  expect(shortPath('C:\\Users\\me\\code\\x', 'C:\\')).toBe('…\\code\\x')
  expect(shortPath('/home/sam/www/site', '/')).toBe('…/www/site')
})

test('a long path outside the root keeps its last two folders', () => {
  expect(shortPath('C:\\Users\\KG\\AppData\\Local\\Temp\\patchbay-scene-x\\app')).toBe('…\\patchbay-scene-x\\app')
  expect(shortPath('/Users/sam/code/site/www')).toBe('…/site/www')
})

test('short and empty paths come back as they are', () => {
  expect(shortPath('C:\\Users\\KG')).toBe('C:\\Users\\KG')
  expect(shortPath('/tmp/x')).toBe('/tmp/x')
  expect(shortPath('')).toBe('')
})
