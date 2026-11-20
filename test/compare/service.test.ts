import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { gitEnvFrom } from '../../src/core/git/args'
import type { RunResult } from '../../src/core/git/run'
import { createGitService, LIMITS, systemGit } from '../../src/core/git/service'
import { createWorktree, removeWorktree } from '../../src/core/worktree/service'
import { reduce } from '../../src/core/canvas/reduce'
import { createCompareReads } from '../../src/main/compare/reads'
import { createCompareService, type CompareServiceDeps } from '../../src/main/compare/service'
import { readAgentsFrom } from '../../src/main/agentsAllowed'
import type { AttemptState, RemovalCheck, StartComparison } from '../../src/shared/compare'
import type { CanvasStore } from '../../src/shared/contract'
import type { CanvasDoc, ClaudeNode, GroupNode } from '../../src/shared/model'
import { patientGit, removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

let root: string
let repo: string

function sh(cwd: string, ...args: string[]): string {
  // Optional locks off, as Patchbay's own reads have them, so the test's own status calls don't rewrite the index.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
}

function makeRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  sh(path, 'init', '-q', '-b', 'main')
  // Written at once rather than by four more git runs: each one costs seconds on a busy machine.
  appendFileSync(join(path, '.git', 'config'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n')
  writeFileSync(join(path, 'app.txt'), 'one\ntwo\n')
  sh(path, 'add', 'app.txt')
  sh(path, 'commit', '-q', '-m', 'first')
  return path
}

function store(): CanvasStore {
  let doc: CanvasDoc = { version: 3, projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p', nodes: [], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
  return { get: () => doc, dispatch: (op) => void (doc = reduce(doc, op)), subscribe: () => () => {} }
}

const env = gitEnvFrom(Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string')))
const git = patientGit(systemGit(env))
const reads = createCompareReads(git, createGitService(git))

type World = ReturnType<typeof world>
function world(over: Partial<CompareServiceDeps> = {}) {
  const s = store()
  const started: string[] = []
  const stopped: string[] = []
  const verifyRuns: { argv: string[]; cwd: string }[] = []
  let verifyCode = 0
  let t = 1000
  const deps: CompareServiceDeps = {
    store: s,
    runner: { startNode: async (id) => void started.push(id), stopNode: async (id) => void stopped.push(id) },
    reads,
    file: join(root, 'data', 'comparisons.json'),
    createWorktree,
    removeWorktree,
    git: (cwd, args) => git(cwd, args, LIMITS.write),
    runVerify: async (argv, cwd): Promise<RunResult> => {
      verifyRuns.push({ argv, cwd })
      return { code: verifyCode, stdout: `ran ${argv.join(' ')}`, stderr: '', truncated: false, timedOut: false, missing: false }
    },
    now: () => (t += 1000),
    ...over
  }
  const service = createCompareService(deps)
  return { s, service, started, stopped, verifyRuns, setVerifyCode: (c: number) => void (verifyCode = c), deps }
}

const startReq = async (over: Partial<StartComparison> = {}): Promise<StartComparison> => {
  const info = await reads.source(repo)
  if (!info.ok) throw new Error(info.reason)
  return {
    projectId: 'p',
    source: repo,
    brief: 'Make app.txt count to three',
    base: info.commit,
    leaveOutUncommitted: false,
    attempts: [
      { agent: 'claude', approach: '', branch: 'try/count-a' },
      { agent: 'codex', approach: 'Use a loop', branch: 'try/count-b' }
    ],
    verify: 'node check.js',
    ...over
  }
}

async function started(w: World, over: Partial<StartComparison> = {}) {
  const r = await w.service.start(await startReq(over))
  if (!r.ok) throw new Error(r.reason)
  return r.comparison
}

const branches = (): string[] => sh(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort()
const worktrees = (): string[] => sh(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))
const okState = (s: AttemptState) => {
  if (!s.ok) throw new Error(s.reason)
  return s
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'patchbay-compare-')))
  repo = makeRepo(join(root, 'repo'))
})

afterEach(() => removeTemp(root))

test('attempts begin from the recorded base, in distinct worktrees, branches and agents', async () => {
  const w = world()
  const base = sh(repo, 'rev-parse', 'HEAD')
  const c = await started(w)
  expect(c.base).toMatchObject({ commit: base, branch: 'main', uncommitted: 'none' })
  expect(c.attempts.map((a) => a.branch)).toEqual(['try/count-a', 'try/count-b'])
  const [a, b] = c.attempts
  expect(a.path).not.toBe(b.path)
  expect(a.path).not.toBe(repo)
  for (const x of c.attempts) expect(sh(x.path, 'rev-parse', 'HEAD')).toBe(base)

  const nodes = w.s.get().nodes
  const agents = nodes.filter((n): n is ClaudeNode => n.kind === 'claude')
  expect(agents.map((n) => [n.agent, n.cwd])).toEqual([['claude', a.path], ['codex', b.path]])
  expect(agents[0].prompt).toBe('Make app.txt count to three')
  expect(agents[1].prompt).toBe('Make app.txt count to three\n\nApproach for this attempt: Use a loop')
  expect(nodes.filter((n): n is GroupNode => n.kind === 'group').map((g) => g.worktree?.path)).toEqual([a.path, b.path])
  expect(w.started).toEqual(agents.map((n) => n.id))
})

test('uncommitted changes in the source are refused unless left out explicitly, and are never copied or touched', async () => {
  writeFileSync(join(repo, 'app.txt'), 'one\ntwo\nlocal edit\n')
  writeFileSync(join(repo, 'scratch.txt'), 'mine\n')
  const w = world()
  const refused = await w.service.start(await startReq())
  expect(refused).toMatchObject({ ok: false })
  expect((refused as { reason: string }).reason).toMatch(/2 uncommitted changes/)
  expect(branches()).toEqual(['main'])
  expect(worktrees()).toHaveLength(1)
  expect(w.s.get().nodes).toEqual([])

  const c = await started(w, { leaveOutUncommitted: true })
  expect(c.base.uncommitted).toBe('left-out')
  for (const a of c.attempts) {
    expect(readFileSync(join(a.path, 'app.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(existsSync(join(a.path, 'scratch.txt'))).toBe(false)
  }
  expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('one\ntwo\nlocal edit\n')
  expect(readFileSync(join(repo, 'scratch.txt'), 'utf8')).toBe('mine\n')
})

test('start uses the commit the dialog showed, even if HEAD has moved since', async () => {
  const req = await startReq()
  writeFileSync(join(repo, 'app.txt'), 'moved\n')
  sh(repo, 'commit', '-q', '-am', 'second')
  const c = await started(world(), { base: req.base })
  for (const a of c.attempts) expect(sh(a.path, 'rev-parse', 'HEAD')).toBe(req.base)
  expect(c.base.commit).toBe(req.base)
  expect(c.base.branch).toBeNull()
})

test('an existing branch is refused before anything is made', async () => {
  sh(repo, 'branch', 'try/count-b')
  const w = world()
  const r = await w.service.start(await startReq())
  expect(r).toMatchObject({ ok: false, reason: 'A branch named "try/count-b" already exists.' })
  expect(worktrees()).toHaveLength(1)
  expect(w.s.get().nodes).toEqual([])
})

test("if B can't be made, A is left in place, recorded, and the reason says so", async () => {
  let calls = 0
  const w = world({
    createWorktree: async (a) => {
      if (++calls === 2) throw new Error('disk full.')
      return createWorktree(a)
    }
  })
  const r = await w.service.start(await startReq())
  expect(r.ok).toBe(false)
  expect((r as { reason: string }).reason).toMatch(/Attempt B could not be made: disk full\. Left in place: attempt A's worktree/)
  expect(w.service.list('p')).toHaveLength(1)
  expect(w.service.list('p')[0].attempts.map((a) => a.key)).toEqual(['a'])
})

test('results show committed and uncommitted changes against the base, separately', async () => {
  const w = world()
  const c = await started(w)
  const [a, b] = c.attempts
  writeFileSync(join(a.path, 'app.txt'), 'one\ntwo\nthree\n')
  sh(a.path, 'commit', '-q', '-am', 'count to three')
  writeFileSync(join(a.path, 'notes.md'), 'idea\n')
  writeFileSync(join(b.path, 'app.txt'), 'one\ntwo\n3\n')

  const sa = okState(await w.service.state(c.id, 'a'))
  expect(sa.commits.map((x) => x.subject)).toEqual(['count to three'])
  expect(sa.committed).toEqual([{ path: 'app.txt', added: 1, removed: 0 }])
  expect(sa.uncommitted).toEqual([{ path: 'notes.md', added: null, removed: null, untracked: true }])
  expect(sa.fromBase).toBe(true)
  expect(sa.unmerged).toBe(1)

  const sb = okState(await w.service.state(c.id, 'b'))
  expect(sb.commits).toEqual([])
  expect(sb.committed).toEqual([])
  expect(sb.uncommitted).toEqual([{ path: 'app.txt', added: 1, removed: 0 }])

  const committed = await w.service.diff(c.id, 'a', 'app.txt', 'committed')
  expect(committed.ok && committed.text).toMatch(/\+three/)
  const untracked = await w.service.diff(c.id, 'a', 'notes.md', 'uncommitted')
  expect(untracked.ok && untracked.text).toMatch(/\+idea/)
  // Only files the attempt lists can be read.
  expect(await w.service.diff(c.id, 'a', '../repo/app.txt', 'uncommitted')).toMatchObject({ ok: false })
})

test('comparing does not modify, commit or merge either attempt', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  writeFileSync(join(a.path, 'app.txt'), 'changed\n')
  const snapshot = () => ({
    heads: c.attempts.map((x) => sh(x.path, 'rev-parse', 'HEAD')),
    status: c.attempts.map((x) => sh(x.path, 'status', '--porcelain')),
    branches: sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    index: c.attempts.map((x) => statSync(sh(x.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).mtimeMs)
  })
  const before = snapshot()
  await w.service.state(c.id, 'a')
  await w.service.state(c.id, 'b')
  await w.service.diff(c.id, 'a', 'app.txt', 'uncommitted')
  await w.service.choose(c.id, 'a')
  await w.service.choose(c.id, null)
  expect(snapshot()).toEqual(before)
})

test('choosing a winner only records the choice', async () => {
  const w = world()
  const c = await started(w)
  const mainBefore = sh(repo, 'rev-parse', 'main')
  const r = await w.service.choose(c.id, 'b')
  expect(r.ok && r.comparison.chosen).toMatchObject({ key: 'b', head: c.base.commit })
  expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore)
  expect(sh(repo, 'branch', '--show-current')).toBe('main')
  const cleared = await w.service.choose(c.id, null)
  expect(cleared.ok && cleared.comparison.chosen).toBeUndefined()
})

test('verification runs the same command in each worktree and records what it ran against', async () => {
  const w = world()
  const c = await started(w)
  const [a, b] = c.attempts
  w.setVerifyCode(0)
  const ra = await w.service.verify(c.id, 'a')
  w.setVerifyCode(1)
  const rb = await w.service.verify(c.id, 'b')
  expect(w.verifyRuns).toEqual([
    { argv: ['node', 'check.js'], cwd: a.path },
    { argv: ['node', 'check.js'], cwd: b.path }
  ])
  const va = ra.ok ? ra.comparison.attempts[0].verify! : null
  const vb = rb.ok ? rb.comparison.attempts[1].verify! : null
  expect(va).toMatchObject({ argv: ['node', 'check.js'], cwd: a.path, exitCode: 0, head: c.base.commit, output: 'ran node check.js' })
  expect(vb).toMatchObject({ exitCode: 1 })
  expect(va!.durationMs).toBeGreaterThan(0)

  // Kept across a restart.
  const again = createCompareService(w.deps)
  expect(again.get(c.id)!.attempts.map((x) => x.verify?.exitCode)).toEqual([0, 1])
})

test('a comparison without a command has nothing to run', async () => {
  const w = world()
  const c = await started(w, { verify: '' })
  expect(c.verify).toBeNull()
  expect(await w.service.verify(c.id, 'a')).toMatchObject({ ok: false })
})

test('cleanup keeps uncommitted work unless that specific removal is confirmed', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  writeFileSync(join(a.path, 'app.txt'), 'unsaved work\n')

  const refused = await w.service.remove(c.id, 'a', { deleteBranch: false })
  expect(refused).toMatchObject({ ok: false, needs: { uncommitted: 1, unmerged: 0 } })
  expect(existsSync(a.path)).toBe(true)
  expect(readFileSync(join(a.path, 'app.txt'), 'utf8')).toBe('unsaved work\n')
  expect(w.stopped).toEqual([])

  // A confirmation for some other state doesn't count.
  const needs = (refused as { needs: RemovalCheck }).needs
  writeFileSync(join(a.path, 'more.txt'), 'more\n')
  const again = await w.service.remove(c.id, 'a', { deleteBranch: false, confirm: needs })
  expect(again).toMatchObject({ ok: false, needs: { uncommitted: 2 } })
  expect(existsSync(join(a.path, 'more.txt'))).toBe(true)

  const removed = await w.service.remove(c.id, 'a', { deleteBranch: false, confirm: (again as { needs: RemovalCheck }).needs })
  expect(removed.ok).toBe(true)
  expect(existsSync(a.path)).toBe(false)
  expect(branches()).toContain('try/count-a')
  expect(w.stopped).toEqual([w.s.get().nodes.find((n) => n.kind === 'claude' && n.cwd === a.path)!.id])
  expect((w.s.get().nodes.find((n) => n.id === a.groupId) as GroupNode).worktree).toBeNull()
  expect(w.service.get(c.id)!.attempts[0].removed).toMatchObject({ branchDeleted: false })
})

test('a clean worktree is removed and its branch with unmerged commits kept unless deleting it is confirmed', async () => {
  const w = world()
  const c = await started(w)
  const [, b] = c.attempts
  writeFileSync(join(b.path, 'app.txt'), 'b\n')
  sh(b.path, 'commit', '-q', '-am', 'b work')

  const refused = await w.service.remove(c.id, 'b', { deleteBranch: true })
  expect(refused).toMatchObject({ ok: false, needs: { uncommitted: 0, unmerged: 1 } })
  expect(existsSync(b.path)).toBe(true)

  const kept = await w.service.remove(c.id, 'b', { deleteBranch: false })
  expect(kept.ok).toBe(true)
  expect(existsSync(b.path)).toBe(false)
  expect(branches()).toContain('try/count-b')
})

test('deleting a branch with unmerged commits needs that confirmation, and then deletes it', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  writeFileSync(join(a.path, 'app.txt'), 'a\n')
  sh(a.path, 'commit', '-q', '-am', 'a work')
  const refused = await w.service.remove(c.id, 'a', { deleteBranch: true })
  const needs = (refused as { needs: RemovalCheck }).needs
  const r = await w.service.remove(c.id, 'a', { deleteBranch: true, confirm: needs })
  expect(r.ok).toBe(true)
  expect(branches()).not.toContain('try/count-a')
})

test('a merged branch can be deleted without asking', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  writeFileSync(join(a.path, 'app.txt'), 'a\n')
  sh(a.path, 'commit', '-q', '-am', 'a work')
  sh(repo, 'merge', '-q', '--ff-only', 'try/count-a')
  expect(okState(await w.service.state(c.id, 'a')).unmerged).toBe(0)
  expect((await w.service.remove(c.id, 'a', { deleteBranch: true })).ok).toBe(true)
  expect(branches()).not.toContain('try/count-a')
})

test('an unreadable comparisons file is kept aside, not overwritten', async () => {
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'comparisons.json'), '{ not json')
  const w = world()
  expect(w.service.list('p')).toEqual([])
  // A second bad file doesn't replace the first.
  writeFileSync(join(root, 'data', 'comparisons.json'), '{ also not json')
  world({ now: () => 99_000 })
  const kept = readdirSync(join(root, 'data')).filter((f) => f.startsWith('comparisons.json.bad-'))
  expect(kept.map((f) => readFileSync(join(root, 'data', f), 'utf8')).sort()).toEqual(['{ also not json', '{ not json'])
})

test('work written while the sessions stop is not lost under an earlier confirmation', async () => {
  let w: World
  const c = await (async () => {
    w = world({
      runner: {
        startNode: async () => {},
        // The agent saves one more file as it is stopped.
        stopNode: async () => void writeFileSync(join(c0!.attempts[0].path, 'late.txt'), 'late\n')
      }
    })
    return started(w!)
  })()
  const c0 = c
  const [a] = c.attempts
  writeFileSync(join(a.path, 'app.txt'), 'unsaved\n')
  const refused = await w!.service.remove(c.id, 'a', { deleteBranch: false })
  const needs = (refused as { needs: RemovalCheck }).needs
  const r = await w!.service.remove(c.id, 'a', { deleteBranch: false, confirm: needs })
  expect(r).toMatchObject({ ok: false, needs: { uncommitted: 2 } })
  expect(readFileSync(join(a.path, 'late.txt'), 'utf8')).toBe('late\n')
})

test("a worktree made for an attempt whose agent couldn't start is named as left in place", async () => {
  const w = world({ runner: { startNode: async () => { throw new Error('no agent.') }, stopNode: async () => {} } })
  const r = await w.service.start(await startReq())
  expect(r.ok).toBe(false)
  expect((r as { reason: string }).reason).toMatch(/Attempt A could not be made: no agent\. Left in place: attempt A's worktree .*try-count-a on branch try\/count-a\./)
})

test('a confirmation covers the content shown, not just the number of changed files', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  writeFileSync(join(a.path, 'app.txt'), 'first draft\n')
  const refused = await w.service.remove(c.id, 'a', { deleteBranch: false })
  const needs = (refused as { needs: RemovalCheck }).needs
  expect(needs.files).toEqual(['app.txt'])
  // Same file, same count, same commit: different work.
  writeFileSync(join(a.path, 'app.txt'), 'second draft, never seen\n')
  const r = await w.service.remove(c.id, 'a', { deleteBranch: false, confirm: needs })
  expect(r).toMatchObject({ ok: false, needs: { uncommitted: 1 } })
  expect(readFileSync(join(a.path, 'app.txt'), 'utf8')).toBe('second draft, never seen\n')
})

test('the change fingerprint covers all of a large change, past what a diff read would keep', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  const big = 'x'.repeat(3 * 1024 * 1024)
  writeFileSync(join(a.path, 'aaa-big.txt'), `${big}\n`)
  writeFileSync(join(a.path, 'app.txt'), 'one\n')
  const first = okState(await w.service.state(c.id, 'a')).changes
  writeFileSync(join(a.path, 'app.txt'), 'two\n')
  expect(okState(await w.service.state(c.id, 'a')).changes).not.toBe(first)
})

test('ignored files are listed and need confirmation before the worktree goes', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  writeFileSync(join(a.path, '.gitignore'), '.env.local\n')
  sh(a.path, 'add', '.gitignore')
  sh(a.path, 'commit', '-q', '-m', 'ignore env')
  writeFileSync(join(a.path, '.env.local'), 'TOKEN=local\n')
  const refused = await w.service.remove(c.id, 'a', { deleteBranch: false })
  expect(refused).toMatchObject({ ok: false, needs: { ignored: 1, ignoredFiles: ['.env.local'], uncommitted: 0 } })
  expect((refused as { reason: string }).reason).toMatch(/1 git-ignored file or folder/)
  expect(existsSync(join(a.path, '.env.local'))).toBe(true)
  const r = await w.service.remove(c.id, 'a', { deleteBranch: false, confirm: (refused as { needs: RemovalCheck }).needs })
  expect(r.ok).toBe(true)
  expect(existsSync(a.path)).toBe(false)
})

test('a folder that is no longer on the attempt branch is not removed', async () => {
  const w = world()
  const c = await started(w)
  const [a] = c.attempts
  sh(a.path, 'switch', '-q', '-c', 'someone-else')
  const r = await w.service.remove(c.id, 'a', { deleteBranch: false })
  expect(r).toMatchObject({ ok: false })
  expect((r as { reason: string }).reason).toMatch(/on branch someone-else now, not try\/count-a/)
  expect(existsSync(a.path)).toBe(true)
})

test('a check that changes files is judged against what it left, and records that it did', async () => {
  const w = world({
    runVerify: async (_argv, cwd): Promise<RunResult> => {
      writeFileSync(join(cwd, 'app.txt'), 'formatted\n')
      return { code: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false, missing: false }
    }
  })
  const c = await started(w)
  const r = await w.service.verify(c.id, 'a')
  const v = r.ok ? r.comparison.attempts[0].verify! : null
  expect(v!.after).toBeDefined()
  expect(v!.after!.changes).not.toBe(v!.changes)
  const { verifyStanding } = await import('../../src/shared/compare')
  expect(verifyStanding(r.ok ? r.comparison.attempts[0] : {}, await w.service.state(c.id, 'a')).kind).toBe('current')
})

test('a comparisons file from a newer build is shown but never written over', async () => {
  mkdirSync(join(root, 'data'), { recursive: true })
  const file = join(root, 'data', 'comparisons.json')
  const newer = JSON.stringify({ schema: 2, comparisons: [], futureField: true })
  writeFileSync(file, newer)
  const w = world()
  expect(w.service.list('p')).toEqual([])
  expect(await w.service.start(await startReq())).toMatchObject({ ok: false, reason: expect.stringMatching(/newer version of Patchbay/) })
  expect(readFileSync(file, 'utf8')).toBe(newer)
  expect(worktrees()).toHaveLength(1)
})

test("comparisons of a deleted project are still listed, after the project's own", async () => {
  const w = world()
  const c = await started(w)
  w.s.dispatch({ op: 'addProject', project: { id: 'q', name: 'Q', folder: '', viewport: { x: 0, y: 0, zoom: 1 } } })
  expect(w.service.list('q').map((x) => x.id)).toEqual([])
  w.s.dispatch({ op: 'removeProject', id: 'p', at: Date.now() })
  expect(w.s.get().projects.map((p) => p.id)).toEqual(['q'])
  const listed = w.service.list('q')
  expect(listed.map((x) => x.id)).toEqual([c.id])
})

test("both attempts' groups land side by side where the person is looking, clear of what's there", async () => {
  const w = world()
  const sticky = (id: string, x: number, y: number) =>
    w.s.dispatch({ op: 'addNode', node: { id, kind: 'sticky', title: id, text: '', x, y, width: 280, height: 220, parentId: null, projectId: 'p' } })
  // One note where the view starts, one far off to the right, where "right of everything" used to put them.
  sticky('here', 80, 80)
  sticky('far', 5000, 0)
  await started(w)
  const tops = w.s.get().nodes.filter((n) => !n.parentId)
  const groups = tops.filter((n): n is GroupNode => n.kind === 'group')
  expect(groups).toHaveLength(2)
  const covers = (a: GroupNode, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  for (const g of groups) for (const n of tops) if (n.id !== g.id) expect(covers(g, n)).toBe(false)
  expect(groups[1].x).toBe(groups[0].x + groups[0].width + 40)
  expect(groups[1].y).toBe(groups[0].y)
  expect(groups[0].x).toBeLessThan(5000)
})

test('an attempt on an agent turned off in Settings > Agents is refused before anything is made', async () => {
  readAgentsFrom(() => ({ agentsOff: 'codex' }))
  try {
    const w = world()
    const r = await w.service.start(await startReq())
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/^Attempt B: Codex is turned off in Settings > Agents.*Choose Claude Code for it instead\./) })
    expect(w.s.get().nodes).toEqual([])
    expect(worktrees()).toHaveLength(1)
    expect(branches()).toEqual(['main'])
    // The person picks the agent that's on, and it starts.
    const c = await started(w, { attempts: [{ agent: 'claude', approach: '', branch: 'try/count-a' }, { agent: 'claude', approach: '', branch: 'try/count-b' }] })
    expect(c.attempts.map((a) => a.agent)).toEqual(['claude', 'claude'])
  } finally {
    readAgentsFrom(() => ({}))
  }
})
