import { expect, test } from 'vitest'
import { terminalFolderFor } from '../../src/renderer/terminalProfilesUi'

// The New terminal form, the menus and the palette all decide a new terminal's folder with this, in the same order as
// `patchbay open-terminal`: --cwd, the group's worktree, the profile's folder, then the usual default.

test("picking a profile with its own folder in a worktree group keeps the worktree", () => {
  expect(terminalFolderFor({ worktree: 'C:\\repo-wt', profileCwd: 'C:\\proj', fallback: 'C:\\repo' })).toBe('C:\\repo-wt')
})

test("outside a worktree group, the profile's folder (the default's, with none picked) comes before the usual one", () => {
  expect(terminalFolderFor({ profileCwd: 'C:\\proj', fallback: 'C:\\repo' })).toBe('C:\\proj')
  expect(terminalFolderFor({ fallback: 'C:\\repo' })).toBe('C:\\repo')
})

test('a folder the person chose wins over all of them', () => {
  expect(terminalFolderFor({ chosen: 'D:\\mine', worktree: 'C:\\repo-wt', profileCwd: 'C:\\proj', fallback: 'C:\\repo' })).toBe('D:\\mine')
})
