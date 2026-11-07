import { expect, test } from 'vitest'
import { commitArgs, discardArgs, gitEnvFrom, logArgs, plainBranchName, pullArgs, pushArgs, stageArgs, switchArgs, unstageArgs } from '../../src/core/git/args'
import { layoutGraph, parseBranches, parseLog, parseStatusV2, type RawCommit } from '../../src/core/git/parse'

test('porcelain v2 status: branch headers, staged and unstaged sides, renames, conflicts and untracked', () => {
  const text = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb staged only.txt',
    '1 .M N... 100644 100644 100644 aaa aaa src/with space.ts',
    '1 MD N... 100644 100644 000000 aaa bbb both.txt',
    '2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt',
    'old name.txt',
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
    '? untracked dir/file.txt',
    ''
  ].join('\0')
  const s = parseStatusV2(text)
  expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 })
  expect(s.staged).toEqual([
    { path: 'staged only.txt', letter: 'M', area: 'staged' },
    { path: 'both.txt', letter: 'M', area: 'staged' },
    { path: 'new name.txt', origPath: 'old name.txt', letter: 'R', area: 'staged' }
  ])
  expect(s.unstaged).toEqual([
    { path: 'src/with space.ts', letter: 'M', area: 'unstaged' },
    { path: 'both.txt', letter: 'D', area: 'unstaged' },
    { path: 'untracked dir/file.txt', letter: '?', area: 'untracked' }
  ])
  expect(s.conflicts).toEqual([{ path: 'conflict.txt', letter: 'U', area: 'conflict' }])
})

test('porcelain v2 status: a new repository and a detached HEAD', () => {
  expect(parseStatusV2('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ oid: null, branch: 'main', upstream: null })
  expect(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0').branch).toBeNull()
})

test('branches: local and remote, current, tracking, and the remote HEAD alias left out', () => {
  const line = (...f: string[]): string => f.join('\0')
  const text = [
    line('refs/heads/main', 'main', '*', 'origin/main', '[ahead 1, behind 2]', 'abc1234'),
    line('refs/heads/old', 'old', ' ', 'origin/old', '[gone]', 'def5678'),
    line('refs/remotes/origin/HEAD', 'origin', ' ', '', '', 'abc1234'),
    line('refs/remotes/origin/main', 'origin/main', ' ', '', '', 'abc1234')
  ].join('\n')
  const b = parseBranches(text)
  expect(b.map((x) => x.name)).toEqual(['main', 'old', 'origin/main'])
  expect(b[0]).toMatchObject({ current: true, ahead: 1, behind: 2, remote: false })
  expect(b[1].gone).toBe(true)
  expect(b[2].remote).toBe(true)
})

const commit = (hash: string, parents: string[], subject = hash): RawCommit => ({ hash: hash.padEnd(40, '0'), parents: parents.map((p) => p.padEnd(40, '0')), refs: [], author: 'a', time: 0, subject })

test('log parsing reads fields, refs and parents', () => {
  const text = `${'a'.repeat(40)}\x1f${'b'.repeat(40)} ${'c'.repeat(40)}\x1fHEAD -> main, origin/main\x1fAnn\x1f1700000000\x1fMerge it\x1e\n`
  const [c] = parseLog(text)
  expect(c).toMatchObject({ parents: ['b'.repeat(40), 'c'.repeat(40)], refs: ['HEAD -> main', 'origin/main'], author: 'Ann', time: 1700000000000, subject: 'Merge it' })
})

test('graph lanes: a straight line stays in lane 0', () => {
  const rows = layoutGraph([commit('c', ['b']), commit('b', ['a']), commit('a', [])])
  expect(rows.map((r) => r.col)).toEqual([0, 0, 0])
  expect(rows.every((r) => r.width === 1)).toBe(true)
})

test('graph lanes: a merge opens a second lane that joins back at the fork point', () => {
  // m merges f into main. f and b both come from a.
  const rows = layoutGraph([commit('m', ['b', 'f']), commit('f', ['a']), commit('b', ['a']), commit('a', [])])
  const [m, f, b, a] = rows
  expect(m.merge).toBe(true)
  expect(m.col).toBe(0)
  expect(m.segments.filter((s) => s.y1 === 0.5)).toEqual([
    { x1: 0, y1: 0.5, x2: 0, y2: 1, lane: 0 },
    { x1: 0, y1: 0.5, x2: 1, y2: 1, lane: 1 }
  ])
  expect(f.col).toBe(1)
  expect(b.col).toBe(0)
  // At a, both lanes waiting for it converge into lane 0.
  expect(a.col).toBe(0)
  expect(a.segments.filter((s) => s.y2 === 0.5).map((s) => s.x1).sort()).toEqual([0, 1])
  expect(a.width).toBe(2)
})

test('graph lanes: parents beyond the shown commits open no lane', () => {
  const rows = layoutGraph([commit('b', ['a'])])
  expect(rows[0].segments).toEqual([])
})

test('arguments: paths always follow --, and nothing interactive', () => {
  expect(stageArgs(['-rf'])).toEqual(['add', '--', '-rf'])
  expect(stageArgs('all')).toEqual(['add', '--all'])
  expect(unstageArgs(['a'], true)).toEqual(['reset', '-q', '--', 'a'])
  expect(unstageArgs(['a'], false)).toEqual(['rm', '--cached', '-q', '--', 'a'])
  expect(discardArgs(['t.txt'], ['new.txt'])).toEqual([['checkout', '--', 't.txt'], ['clean', '-f', '-q', '--', 'new.txt']])
  expect(discardArgs([], [])).toEqual([])
  expect(commitArgs('-m trick')).toEqual(['commit', '-q', '-m', '-m trick'])
  expect(switchArgs('origin/x', true)).toEqual(['switch', '--track', 'origin/x'])
  expect(pullArgs('ff-only')).toEqual(['pull', '--ff-only'])
  expect(pullArgs('merge')).toEqual(['pull', '--no-rebase', '--no-edit'])
  expect(pushArgs({ branch: 'main', upstream: 'origin/main', remote: 'origin' })).toEqual(['push'])
  expect(pushArgs({ branch: 'feat', upstream: null, remote: 'origin' })).toEqual(['push', '--set-upstream', 'origin', 'feat'])
  expect(logArgs(10)).toContain('--topo-order')
})

test('branch names: plain ones only', () => {
  for (const ok of ['main', 'feature/x', 'issue-12']) expect(plainBranchName(ok)).toBe(true)
  for (const bad of ['', '-f', 'a b', 'a..b', 'x.lock', '@{-1}', 'a/', '/a', 'a~1', 'a:b']) expect(plainBranchName(bad)).toBe(false)
})

test('environment: prompts off and redirecting variables removed', () => {
  const env = gitEnvFrom({ PATH: 'p', GIT_DIR: 'x', GIT_ASKPASS: 'y', GIT_TERMINAL_PROMPT: '1' })
  expect(env).toEqual({ PATH: 'p', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', SSH_ASKPASS_REQUIRE: 'never' })
})
