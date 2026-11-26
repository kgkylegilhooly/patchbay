import { beforeEach, expect, test, vi } from 'vitest'
import { commitMessageFrom, openCommitOwn, stagedNotice, useCommitPrep } from '../../src/renderer/commitOwn'

beforeEach(() => useCommitPrep.setState({ prep: null }))

test("the message is the last reply's first line, without the mark of a cut, and empty with no reply", () => {
  expect(commitMessageFrom('Fixed the login redirect')).toBe('Fixed the login redirect')
  expect(commitMessageFrom('Fixed the login redirect and the session cookie that…')).toBe('Fixed the login redirect and the session cookie that')
  expect(commitMessageFrom(null)).toBe('')
})

test('the chip hands the panel its files and message, then opens it on its folder', async () => {
  const open = vi.fn()
  await openCommitOwn({ id: 'a', title: 'Fix the login', cwd: 'C:\repo\app' }, ['src/login.ts', 'test/login.test.ts'], open, async () => 'Fixed the login redirect.')
  expect(useCommitPrep.getState().prep).toEqual({ folder: 'C:\repo\app', paths: ['src/login.ts', 'test/login.test.ts'], message: 'Fixed the login redirect.', by: 'Fix the login' })
  expect(open).toHaveBeenCalledWith('C:\repo\app')
})

test("a reply that can't be read still opens the panel, with no message", async () => {
  const open = vi.fn()
  await openCommitOwn({ id: 'a', title: 'A', cwd: 'C:\repo' }, ['x.ts'], open, async () => {
    throw new Error('gone')
  })
  expect(useCommitPrep.getState().prep?.message).toBe('')
  expect(open).toHaveBeenCalledOnce()
})

test('the notice says what else is staged, since it would go in the same commit', () => {
  const prep = { paths: ['a.ts', 'b.ts'], message: 'Done', by: 'Fix the login' }
  expect(stagedNotice(prep, [], true)).toBe('Fix the login: 2 files staged, with its last reply as the message. Nothing is committed until you press Commit.')
  expect(stagedNotice(prep, ['a.ts', 'notes.md'], false)).toBe('Fix the login: 2 files staged. 1 other staged file would go in this commit too. Nothing is committed until you press Commit.')
})
