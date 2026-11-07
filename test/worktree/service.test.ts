import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkRemovable, createWorktree, defaultWorktreePath, removeWorktree } from '../../src/core/worktree/service'

let root: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.name', 'Test')
  git(path, 'config', 'user.email', 'test@example.invalid')
  git(path, 'config', 'commit.gpgsign', 'false')
  git(path, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(path, 'file.txt'), 'original\n')
  git(path, 'add', 'file.txt')
  git(path, 'commit', '-q', '-m', 'first')
  return path
}

const branchExists = (name: string) => git(repo, 'branch', '--list', name) !== ''
const worktreeCount = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'patchbay-wt-')))
  repo = makeRepo(join(root, 'repo'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('defaultWorktreePath is <parent>/<name>-worktrees/<branch with / as ->', () => {
  expect(defaultWorktreePath(join(root, 'repo'), 'feature/a/b')).toBe(join(root, 'repo-worktrees', 'feature-a-b'))
  expect(defaultWorktreePath(`${join(root, 'repo')}/`, 'x')).toBe(join(root, 'repo-worktrees', 'x'))
})

test('creates a worktree on a new branch; git reports that branch there', async () => {
  const wt = await createWorktree({ repo, branch: 'topic' })

  expect(wt).toEqual({ path: join(root, 'repo-worktrees', 'topic'), branch: 'topic', repo })
  expect(git(wt.path, 'branch', '--show-current')).toBe('topic')
  expect(readFileSync(join(wt.path, 'file.txt'), 'utf8')).toBe('original\n')
  expect(git(repo, 'branch', '--show-current')).toBe('main')
})

test('an explicit path is used, and a relative one resolves against the repo', async () => {
  const explicit = await createWorktree({ repo, branch: 'a', path: join(root, 'chosen place') })
  const relative = await createWorktree({ repo, branch: 'b', path: '../rel' })

  expect(explicit.path).toBe(join(root, 'chosen place'))
  expect(git(explicit.path, 'branch', '--show-current')).toBe('a')
  expect(relative.path).toBe(join(root, 'rel'))
  expect(git(relative.path, 'branch', '--show-current')).toBe('b')
})

test('a subfolder of the repo is treated as the repo itself', async () => {
  mkdirSync(join(repo, 'sub'))

  const wt = await createWorktree({ repo: join(repo, 'sub'), branch: 'topic' })

  expect(wt.repo).toBe(repo)
  expect(wt.path).toBe(join(root, 'repo-worktrees', 'topic'))
})

test('branch feature/a-b works and its folder is feature-a-b', async () => {
  const wt = await createWorktree({ repo, branch: 'feature/a-b' })

  expect(wt.branch).toBe('feature/a-b')
  expect(wt.path).toBe(join(root, 'repo-worktrees', 'feature-a-b'))
  expect(git(wt.path, 'branch', '--show-current')).toBe('feature/a-b')
})

test('repo path with a space works', async () => {
  const spaced = makeRepo(join(root, 'my repo & co'))

  const wt = await createWorktree({ repo: spaced, branch: 'topic' })

  expect(wt.path).toBe(join(root, 'my repo & co-worktrees', 'topic'))
  expect(git(wt.path, 'branch', '--show-current')).toBe('topic')
  await expect(removeWorktree(wt)).resolves.toEqual({ ok: true })
  expect(existsSync(wt.path)).toBe(false)
})

test.each(['bad..name', 'has space', '-starts-with-dash', '', 'ends.lock', 'tilde~1'])(
  'invalid branch name rejects with a readable message, nothing created: %j',
  async (branch) => {
    await expect(createWorktree({ repo, branch })).rejects.toThrow(/invalid branch name/i)

    expect(readdirSync(root)).toEqual(['repo'])
    expect(worktreeCount()).toBe(1)
  }
)

test('a reference like @{-1} is not accepted as a branch name', async () => {
  git(repo, 'checkout', '-q', '-b', 'other')
  git(repo, 'checkout', '-q', 'main')

  await expect(createWorktree({ repo, branch: '@{-1}' })).rejects.toThrow(/invalid branch name/i)

  expect(readdirSync(root)).toEqual(['repo'])
})

test('shell metacharacters in a branch name are never run', async () => {
  const marker = join(root, 'pwned')

  await createWorktree({ repo, branch: `x&echo>${'pwned'}` }).catch(() => {})
  await createWorktree({ repo, branch: 'y;touch-pwned' }).catch(() => {})

  expect(existsSync(marker)).toBe(false)
  expect(readdirSync(repo).sort()).toEqual(['.git', 'file.txt'])
})

test('an existing branch rejects, nothing overwritten', async () => {
  writeFileSync(join(repo, 'file.txt'), 'second\n')
  git(repo, 'commit', '-q', '-am', 'second')
  git(repo, 'branch', 'taken', 'HEAD~1')
  const before = git(repo, 'rev-parse', 'taken')

  await expect(createWorktree({ repo, branch: 'taken' })).rejects.toThrow(/already exists/i)

  expect(git(repo, 'rev-parse', 'taken')).toBe(before)
  expect(readdirSync(root)).toEqual(['repo'])
  expect(worktreeCount()).toBe(1)
})

test('a target folder with files in it rejects, and no branch is left behind', async () => {
  const target = join(root, 'occupied')
  mkdirSync(target)
  writeFileSync(join(target, 'keep.txt'), 'precious')

  await expect(createWorktree({ repo, branch: 'topic', path: target })).rejects.toThrow(/already exists/i)

  expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('precious')
  expect(readdirSync(target)).toEqual(['keep.txt'])
  expect(branchExists('topic')).toBe(false)
})

test('a branch name Windows cannot use as a folder rejects and leaves no branch behind', async () => {
  await expect(createWorktree({ repo, branch: 'a|b' })).rejects.toThrow()

  expect(branchExists('a|b')).toBe(false)
  expect(worktreeCount()).toBe(1)
})

test('not a git repo rejects with a readable message', async () => {
  const plain = join(root, 'plain folder')
  mkdirSync(plain)

  await expect(createWorktree({ repo: plain, branch: 'topic' })).rejects.toThrow(/not a git repository/i)

  expect(existsSync(join(root, 'plain folder-worktrees'))).toBe(false)
})

test('a repo folder that does not exist rejects with a readable message', async () => {
  await expect(createWorktree({ repo: join(root, 'gone'), branch: 'topic' })).rejects.toThrow(/not a git repository/i)
})

test('a repo with no commits yet rejects with a readable message', async () => {
  const empty = join(root, 'empty')
  mkdirSync(empty)
  git(empty, 'init', '-q', '-b', 'main')

  await expect(createWorktree({ repo: empty, branch: 'topic' })).rejects.toThrow(/no commits/i)

  expect(existsSync(join(root, 'empty-worktrees'))).toBe(false)
})

test('remove refuses when there are uncommitted changes and keeps the folder', async () => {
  const wt = await createWorktree({ repo, branch: 'topic' })
  writeFileSync(join(wt.path, 'file.txt'), 'edited\n')

  const result = await removeWorktree(wt)

  expect(result.ok).toBe(false)
  expect(result).toMatchObject({ reason: expect.stringMatching(/uncommitted/i) })
  expect(readFileSync(join(wt.path, 'file.txt'), 'utf8')).toBe('edited\n')
  expect(worktreeCount()).toBe(2)
})

test('remove refuses when there are staged changes and keeps the folder', async () => {
  const wt = await createWorktree({ repo, branch: 'topic' })
  writeFileSync(join(wt.path, 'new.txt'), 'staged\n')
  git(wt.path, 'add', 'new.txt')

  const result = await removeWorktree(wt)

  expect(result.ok).toBe(false)
  expect(existsSync(join(wt.path, 'new.txt'))).toBe(true)
})

test('remove refuses when there are untracked files and keeps the folder', async () => {
  const wt = await createWorktree({ repo, branch: 'topic' })
  writeFileSync(join(wt.path, 'untracked.txt'), 'new\n')

  const result = await removeWorktree(wt)

  expect(result.ok).toBe(false)
  expect(result).toMatchObject({ reason: expect.stringMatching(/uncommitted/i) })
  expect(existsSync(join(wt.path, 'untracked.txt'))).toBe(true)
})

test('remove still sees untracked files when git config hides them from status', async () => {
  const wt = await createWorktree({ repo, branch: 'topic' })
  git(repo, 'config', 'status.showUntrackedFiles', 'no')
  writeFileSync(join(wt.path, 'untracked.txt'), 'new\n')

  const result = await removeWorktree(wt)

  expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/uncommitted/i) })
  expect(existsSync(join(wt.path, 'untracked.txt'))).toBe(true)
})

test('remove succeeds when clean and keeps the branch and its commits', async () => {
  const wt = await createWorktree({ repo, branch: 'feature/keep' })
  writeFileSync(join(wt.path, 'work.txt'), 'done\n')
  git(wt.path, 'add', 'work.txt')
  git(wt.path, 'commit', '-q', '-m', 'work')
  const tip = git(wt.path, 'rev-parse', 'HEAD')

  await expect(removeWorktree(wt)).resolves.toEqual({ ok: true })

  expect(existsSync(wt.path)).toBe(false)
  expect(worktreeCount()).toBe(1)
  expect(git(repo, 'rev-parse', 'feature/keep')).toBe(tip)
})

test('remove refuses the main working tree', async () => {
  const result = await removeWorktree({ path: repo, branch: 'main', repo })

  expect(result.ok).toBe(false)
  expect(existsSync(join(repo, 'file.txt'))).toBe(true)
})

test('remove refuses an ordinary folder inside the repo', async () => {
  const sub = join(repo, 'sub')
  mkdirSync(sub)

  const result = await removeWorktree({ path: sub, branch: 'x', repo })

  expect(result.ok).toBe(false)
  expect(existsSync(sub)).toBe(true)
})

test('remove reports a worktree whose folder is already gone, without throwing', async () => {
  const wt = await createWorktree({ repo, branch: 'topic' })
  rmSync(wt.path, { recursive: true, force: true })

  const result = await removeWorktree(wt)

  expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/i) })
  expect(dirname(resolve(wt.path))).toBe(join(root, 'repo-worktrees'))
})

test('checkRemovable refuses a dirty worktree and a missing folder without changing anything', async () => {
  const wt = await createWorktree({ repo, branch: 'check/removable' })
  expect(await checkRemovable(wt)).toEqual({ ok: true })
  writeFileSync(join(wt.path, 'new.txt'), 'x')
  expect(await checkRemovable(wt)).toEqual({ ok: false, reason: 'The worktree has uncommitted changes.' })
  expect(existsSync(wt.path)).toBe(true)
  rmSync(join(wt.path, 'new.txt'))
  await removeWorktree(wt)
  expect((await checkRemovable(wt)).ok).toBe(false)
})
