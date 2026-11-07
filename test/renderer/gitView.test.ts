import { expect, test } from 'vitest'
import { discardWarning, refChip, repoCandidates, switchWarning } from '../../src/renderer/gitView'
import type { RepoStatus } from '../../src/shared/git'
import type { CanvasDoc } from '../../src/shared/model'

const doc: CanvasDoc = {
  version: 3,
  projects: [{ id: 'p', name: 'P', folder: 'C:\\proj', viewport: { x: 0, y: 0, zoom: 1 } }, { id: 'q', name: 'Q', folder: 'C:\\other', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p',
  nodes: [
    { id: 'g', kind: 'group', title: 'G', x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'p', worktree: { path: 'C:\\proj-wt\\feat', branch: 'feat', repo: 'C:\\proj' } },
    { id: 't', kind: 'terminal', title: 'Shell', x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'p', cwd: 'C:\\lib' },
    { id: 'x', kind: 'terminal', title: 'Elsewhere', x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'q', cwd: 'C:\\q' }
  ],
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
}

test('repo candidates: the selection first, then project folder, worktrees and session folders of this project only', () => {
  expect(repoCandidates(doc, []).map((c) => c.label)).toEqual(['Project folder', 'Worktree: feat', 'Session: Shell'])
  expect(repoCandidates(doc, ['t'])[0]).toEqual({ path: 'C:\\lib', label: 'Session: Shell' })
  expect(repoCandidates(doc, ['g'])[0].label).toBe('Worktree: feat')
  expect(repoCandidates(doc, ['x']).some((c) => c.path === 'C:\\q')).toBe(false)
})

test('discard warning says what is lost, naming deleted untracked files', () => {
  const text = discardWarning([{ path: 'a.ts', letter: 'M', area: 'unstaged' }, { path: 'new.txt', letter: '?', area: 'untracked' }])
  expect(text).toMatch(/unstaged changes to 1 file \(a\.ts\)/)
  expect(text).toMatch(/Deletes 1 untracked file \(new\.txt\) from disk/)
  expect(text).toMatch(/can't be undone/)
})

test('switch warning only when tracked work is uncommitted', () => {
  const clean: RepoStatus = { branch: 'main', oid: 'a', upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [{ path: 'u', letter: '?', area: 'untracked' }], conflicts: [] }
  expect(switchWarning(clean, 'x')).toBeNull()
  expect(switchWarning({ ...clean, staged: [{ path: 'a', letter: 'M', area: 'staged' }] }, 'x')).toMatch(/1 file with uncommitted changes.*git refuses/)
})

test('ref chips', () => {
  const remotes = new Set(['origin/main'])
  expect(refChip('HEAD -> main', remotes)).toEqual({ kind: 'head', name: 'main' })
  expect(refChip('origin/main', remotes).kind).toBe('remote')
  expect(refChip('feature/x', remotes).kind).toBe('branch')
  expect(refChip('tag: v1', remotes)).toEqual({ kind: 'tag', name: 'v1' })
})
