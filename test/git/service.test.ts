import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { gitEnvFrom } from '../../src/core/git/args'
import { createGitService, systemGit } from '../../src/core/git/service'
import { patientGit, removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

let root: string
let repo: string
let bare: string
const env = gitEnvFrom(process.env as Record<string, string>)
const svc = createGitService(patientGit(systemGit(env)))

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function configure(path: string): void {
  git(path, 'config', 'user.name', 'Test')
  git(path, 'config', 'user.email', 'test@example.invalid')
  git(path, 'config', 'commit.gpgsign', 'false')
  git(path, 'config', 'core.autocrlf', 'false')
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'patchbay-git-')))
  bare = join(root, 'remote.git')
  repo = join(root, 'repo')
  git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  git(root, 'clone', '-q', bare, repo)
  configure(repo)
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'push', '-q', '-u', 'origin', 'main')
})

afterEach(() => removeTemp(root))

test('stage, unstage, discard and commit on a real repository', async () => {
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  writeFileSync(join(repo, 'new.txt'), 'new\n')
  let s = await svc.status(repo)
  expect(s.unstaged.map((e) => `${e.letter} ${e.path}`)).toEqual(['M a.txt', '? new.txt'])
  expect((await svc.diff(repo, 'a.txt', false)).text).toContain('+two')
  expect((await svc.diff(repo, 'new.txt', false)).text).toContain('+new')

  expect((await svc.stage(repo, ['a.txt'])).ok).toBe(true)
  s = await svc.status(repo)
  expect(s.staged.map((e) => e.path)).toEqual(['a.txt'])
  expect((await svc.unstage(repo, 'all')).ok).toBe(true)
  expect((await svc.status(repo)).staged).toEqual([])

  // Something not listed is refused outright, and nothing else is touched.
  expect((await svc.discard(repo, ['a.txt', 'gone.txt'])).ok).toBe(false)
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('two\n')
  expect((await svc.discard(repo, ['a.txt', 'new.txt'])).ok).toBe(true)
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
  expect(existsSync(join(repo, 'new.txt'))).toBe(false)

  expect(await svc.commit(repo, 'nothing')).toMatchObject({ ok: false })
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  await svc.stage(repo, 'all')
  expect((await svc.commit(repo, 'add b')).ok).toBe(true)
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('add b')
})

test('branches, push with a new upstream, pull, and a merge in the history', async () => {
  expect(await svc.createBranch(repo, '-x')).toMatchObject({ ok: false })
  expect((await svc.createBranch(repo, 'feature')).ok).toBe(true)
  expect((await svc.status(repo)).branch).toBe('feature')
  writeFileSync(join(repo, 'f.txt'), 'f\n')
  await svc.stage(repo, 'all')
  await svc.commit(repo, 'feature work')
  const pushed = await svc.push(repo)
  expect(pushed.ok).toBe(true)
  expect((await svc.status(repo)).upstream).toBe('origin/feature')

  expect((await svc.switchTo(repo, 'main')).ok).toBe(true)
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature')
  const { rows } = await svc.log(repo)
  expect(rows[0]).toMatchObject({ subject: 'Merge feature', merge: true })
  expect(rows.some((r) => r.col === 1)).toBe(true)

  expect((await svc.push(repo)).ok).toBe(true)
  // Another clone pushes; pulling brings it in.
  const other = join(root, 'other')
  git(root, 'clone', '-q', bare, other)
  configure(other)
  writeFileSync(join(other, 'o.txt'), 'o\n')
  git(other, 'add', 'o.txt')
  git(other, 'commit', '-q', '-m', 'from other')
  git(other, 'push', '-q', 'origin', 'main')
  expect((await svc.fetch(repo)).ok).toBe(true)
  expect((await svc.pull(repo, 'ff-only')).ok).toBe(true)
  expect(existsSync(join(repo, 'o.txt'))).toBe(true)
})

test('switching refuses rather than overwrite uncommitted work', async () => {
  await svc.createBranch(repo, 'other')
  writeFileSync(join(repo, 'a.txt'), 'other side\n')
  await svc.stage(repo, 'all')
  await svc.commit(repo, 'change a on other')
  await svc.switchTo(repo, 'main')
  writeFileSync(join(repo, 'a.txt'), 'local edit\n')
  const r = await svc.switchTo(repo, 'other')
  expect(r.ok).toBe(false)
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('local edit\n')
})

test('a push to a remote that does not exist fails plainly', async () => {
  git(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'))
  const r = await svc.push(repo)
  expect(r.ok).toBe(false)
})
