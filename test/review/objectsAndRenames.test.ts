import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createReviewGit, parseNameStatus, systemReviewGit } from '../../src/main/review/git'
import { objectNeeds, OBJECT_LIMITS, pruneObjectStore, sweepObjects, type ObjectLimits } from '../../src/main/review/objectPrune'
import { createReviewService } from '../../src/main/review/service'
import { createReviewStore } from '../../src/main/review/store'
import { createTaskService } from '../../src/main/tasks/service'
import { formatFixRequest, type ReviewMark } from '../../src/shared/reviewInbox'
import type { TaskRevision } from '../../src/shared/task'
import { commentsByLine } from '../../src/renderer/reviewInboxUi'
import { claudeNode, memoryStore } from '../control/fakes'
import { patientGit, removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const DAY = 86_400_000
let dir: string
let repo: string
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true })
const write = (path: string, text: string): void => {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), text)
}
const AUTH = ['export function login(token) {', '  check(token)', '  return session(token)', '}', ''].join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-review-objects-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  write('README.md', 'base\n')
  write('src/auth.js', AUTH)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('switch', '-q', '-c', 'feat/login')
})
afterEach(() => removeTemp(dir))

/** A review service on a throwaway repository, its clock and pruning limits set by the test. */
async function setup(limits: Partial<ObjectLimits> = {}) {
  const store = memoryStore([claudeNode('builder', { projectId: 'p', cwd: repo, title: 'Builder' })])
  store.dispatch({ op: 'addProject', project: { id: 'p', name: 'P', folder: repo, viewport: { x: 0, y: 0, zoom: 1 } } })
  const rev: TaskRevision = { revision: 'abc', fingerprint: 'f', uncommitted: false }
  const tasks = createTaskService(store, dir, async () => {}, async () => rev)
  const task = await tasks.create('p', { brief: 'Validate login tokens', acceptanceCriteria: ['Bad tokens fail'], assignedSessionIds: ['builder'], cwd: repo, requiredChecks: [], dependsOn: [] })
  await tasks.submit('p', task.id, 'builder', 'Added token checks')
  const objects = join(dir, 'data', 'review-objects')
  const reviewGit = createReviewGit(objects, patientGit(systemReviewGit()))
  let t = Date.now()
  const review = createReviewService({
    store, tasks, data: createReviewStore(join(dir, 'data', 'review-inbox.json'), () => {}), git: reviewGit, send: () => ({ ok: true, queued: false }) as never,
    now: () => t, limits: { ...OBJECT_LIMITS, ...limits }
  })
  const shownNow = async () => {
    const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
    return { set, shown: { tree: set.tree, head: set.head, base: set.base?.name, mergeBase: set.base?.mergeBase } }
  }
  /** Loose objects in the review store, over all its folders. */
  const loose = (): string[] =>
    existsSync(objects) ? readdirSync(objects).flatMap((f) => readdirSync(join(objects, f)).filter((s) => /^[0-9a-f]{2}$/.test(s)).flatMap((s) => readdirSync(join(objects, f, s)).map((n) => s + n))) : []
  return { review, reviewGit, task, objects, shownNow, loose, later: (ms: number) => void (t += ms) }
}

test('pruning keeps the latest review and open comments, and removes the snapshots nothing needs', async () => {
  const { review, reviewGit, task, shownNow, loose, later } = await setup({ graceMs: 0, shownMs: 0 })
  // Each look at the changes writes a snapshot of the working folder into Patchbay's own store.
  const trees: string[] = []
  for (let i = 0; i < 5; i++) {
    write('notes/scratch.txt', `draft ${i}\n`)
    trees.push((await shownNow()).set.tree)
  }
  write('src/auth.js', `${AUTH}// reviewed\n`)
  const { shown } = await shownNow()
  await review.markReviewed('p', task.id, shown)
  write('src/auth.js', `${AUTH}// commented\n`)
  const onComment = (await shownNow()).set.tree
  await review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 2, revision: onComment, text: 'Also check expiry', section: 'local' })
  const before = loose().length
  later(1000)

  const r = await review.pruneObjects()
  expect(r.skipped).toEqual([])
  expect(r.removed).toBeGreaterThan(0)
  expect(loose().length).toBeLessThan(before)
  // What nothing needs is gone; the review's snapshot and the comment's are whole.
  for (const t of trees.slice(0, 4)) expect(await reviewGit.objectType(repo, t)).toBeNull()
  expect(await reviewGit.objectType(repo, shown.tree)).toBe('tree')
  expect(await reviewGit.fileAt(repo, shown.tree, 'src/auth.js')).toContain('// reviewed')
  expect(await reviewGit.fileAt(repo, onComment, 'src/auth.js')).toContain('// commented')
  // "Since last review" still uses the snapshot, with no fallback note.
  const since = await review.changes('p', task.id, { kind: 'since-review' })
  expect(since.ranges['since-review']!.from).toBe(shown.tree)
  expect(since.notes.join(' ')).not.toMatch(/cleaned up/)
})

test("a snapshot the window may still be showing is kept, so what it shows can still be marked reviewed", async () => {
  const { review, reviewGit, task, shownNow, later } = await setup({ graceMs: 0 })
  write('notes/scratch.txt', 'on screen\n')
  const { shown } = await shownNow()
  later(60_000)
  await review.pruneObjects()
  expect(await reviewGit.objectType(repo, shown.tree)).toBe('tree')
  expect((await review.markReviewed('p', task.id, shown)).mark.tree).toBe(shown.tree)
})

test("an old review gives up its snapshot, and since-review falls back to the commit reviewed and says so", async () => {
  const { review, reviewGit, task, shownNow, later } = await setup({ graceMs: 0, shownMs: 0, reviewMs: 30 * DAY })
  write('notes/scratch.txt', 'reviewed long ago\n')
  const { shown } = await shownNow()
  await review.markReviewed('p', task.id, shown)
  later(31 * DAY)
  await review.pruneObjects()
  expect(await reviewGit.objectType(repo, shown.tree)).toBeNull()
  // (Unchanged, the folder's next snapshot would be that very tree again, and the comparison exact.)
  write('notes/scratch.txt', 'changed since\n')
  const since = await review.changes('p', task.id, { kind: 'since-review' })
  expect(since.ranges['since-review']!.from).toBe(shown.head)
  expect(since.notes.join(' ')).toMatch(/has been cleaned up \(Patchbay keeps a review's snapshot for 30 days/)
})

test('over its size, a folder gives up the oldest reviews first, never an open comment', async () => {
  const { review, reviewGit, task, shownNow, later } = await setup({ graceMs: 0, shownMs: 0, maxBytes: 1 })
  write('notes/a.txt', 'comment here\n')
  const onComment = (await shownNow()).set.tree
  await review.addComment('p', task.id, { path: 'notes/a.txt', side: 'new', line: 1, revision: onComment, text: 'Explain this', section: 'local' })
  write('notes/b.txt', 'reviewed\n')
  const { shown } = await shownNow()
  await review.markReviewed('p', task.id, shown)
  later(1000)
  const r = await review.pruneObjects()
  expect(r.reviewsDropped).toBe(1)
  expect(await reviewGit.objectType(repo, shown.tree)).toBeNull()
  expect(await reviewGit.fileAt(repo, onComment, 'notes/a.txt')).toBe('comment here\n')
  // Resolved, the comment no longer holds its snapshot.
  const [c] = await review.comments('p', task.id)
  review.setCommentStatus('p', c.id, 'resolved')
  await review.pruneObjects()
  expect(await reviewGit.objectType(repo, onComment)).toBeNull()
})

test('objects written moments ago are kept, as a snapshot may be being written or shown', async () => {
  const { review, task, shownNow, loose } = await setup({ shownMs: 0 })
  write('notes/scratch.txt', 'just now\n')
  await shownNow()
  const before = loose().length
  expect(before).toBeGreaterThan(0)
  await review.pruneObjects()
  expect(loose().length).toBe(before)
  void task
})

test("a snapshot asked for while pruning waits for it, and comes out whole", async () => {
  const { review, reviewGit, shownNow } = await setup({ graceMs: 0, shownMs: 0 })
  write('notes/scratch.txt', 'one\n')
  await shownNow()
  const pruning = review.pruneObjects()
  write('notes/scratch.txt', 'two\n')
  const { set } = await shownNow()
  await pruning
  expect(await reviewGit.fileAt(repo, set.tree, 'notes/scratch.txt')).toBe('two\n')
})

test("a folder no record names loses only very old objects, and goes once empty; a git failure leaves a folder alone", async () => {
  const root = join(dir, 'objects')
  const orphan = join(root, 'aaaaaaaaaaaaaaaa')
  mkdirSync(join(orphan, '12'), { recursive: true })
  mkdirSync(join(orphan, 'pack'), { recursive: true })
  const oldFile = join(orphan, '12', 'a'.repeat(38))
  writeFileSync(oldFile, 'x')
  const now = Date.now()
  utimesSync(oldFile, (now - 40 * DAY) / 1000, (now - 40 * DAY) / 1000)
  const fake = { storeDir: async () => join(root, 'bbbbbbbbbbbbbbbb'), reachable: async (): Promise<Set<string>> => { throw new Error('git broke') } }
  const kept = join(root, 'bbbbbbbbbbbbbbbb', '34')
  mkdirSync(kept, { recursive: true })
  writeFileSync(join(kept, 'b'.repeat(38)), 'y')
  utimesSync(join(kept, 'b'.repeat(38)), (now - 400 * DAY) / 1000, (now - 400 * DAY) / 1000)
  const r = await pruneObjectStore(fake, root, [{ root: repo, required: ['c'.repeat(40)], reviews: [] }], now)
  expect(r).toMatchObject({ removed: 1, foldersRemoved: 1, skipped: [repo] })
  expect(existsSync(orphan)).toBe(false)
  expect(existsSync(join(kept, 'b'.repeat(38)))).toBe(true)
})

test('what the store needs: each task\'s latest review while recent, open comments, and snapshots shown lately', () => {
  const mark = (id: string, taskId: string, at: number, root = 'C:\\Repo'): ReviewMark => ({ id, projectId: 'p', taskId, root, head: null, tree: `tree-${id}`, at, reason: 'marked' })
  const now = 100 * DAY
  const needs = objectNeeds({
    marks: [mark('old', 't1', 10 * DAY), mark('new', 't1', 95 * DAY), mark('stale', 't2', 1 * DAY), mark('other', 't3', 99 * DAY, 'c:\\repo')],
    comments: [{ root: 'C:\\Repo', revision: 'comment-tree' }],
    shown: [{ root: 'C:\\Repo', tree: 'shown-recent', at: now - 1000 }, { root: 'C:\\Repo', tree: 'shown-old', at: now - 2 * DAY }]
  }, now, { reviewMs: 30 * DAY, shownMs: DAY })
  // One folder for the repository however its path is written.
  expect(needs).toHaveLength(1)
  expect(needs[0].reviews).toEqual([{ tree: 'tree-new', at: 95 * DAY }, { tree: 'tree-other', at: 99 * DAY }])
  expect(needs[0].required.sort()).toEqual(['comment-tree', 'shown-recent'])
})

test('a sweep removes only old objects not kept, and the folders it empties', async () => {
  const store = join(dir, 'store')
  const put = (oid: string, ageMs: number): string => {
    mkdirSync(join(store, oid.slice(0, 2)), { recursive: true })
    const f = join(store, oid.slice(0, 2), oid.slice(2))
    writeFileSync(f, oid)
    const at = (Date.now() - ageMs) / 1000
    utimesSync(f, at, at)
    return f
  }
  const keep = put('11'.repeat(20), DAY)
  const young = put('22'.repeat(20), 0)
  const gone = put('33'.repeat(20), DAY)
  const r = await sweepObjects(store, new Set(['11'.repeat(20)]), Date.now() - 60_000)
  expect(r.removed).toBe(1)
  expect(r.bytes).toBe(80)
  expect([existsSync(keep), existsSync(young), existsSync(gone)]).toEqual([true, true, false])
  expect(existsSync(join(store, '33'))).toBe(false)
})

test('a renamed file is listed once, as a rename, and its diff shows the rename and the change', async () => {
  const { review, task } = await setup()
  git('mv', 'src/auth.js', 'src/login.js')
  write('src/login.js', AUTH.replace('check(token)', 'verify(token)'))
  git('commit', '-q', '-am', 'rename auth to login')
  const { set } = await (async () => ({ set: await review.changes('p', task.id, { kind: 'branch', base: 'main' }) }))()
  expect(set.files).toEqual([{ status: 'R', oldPath: 'src/auth.js', path: 'src/login.js', section: 'committed' }])
  const d = await review.fileDiff('p', task.id, set.ranges.committed!, 'src/login.js', 'src/auth.js')
  expect(d.text).toMatch(/rename from src\/auth\.js/)
  expect(d.text).toMatch(/rename to src\/login\.js/)
  expect(d.text).toContain('-  check(token)')
  expect(d.text).toContain('+  verify(token)')
})

test("a removed line of a renamed file is anchored in its old path, and placed there", async () => {
  const { review, task } = await setup()
  git('mv', 'src/auth.js', 'src/login.js')
  write('src/login.js', AUTH.replace('check(token)', 'verify(token)'))
  git('commit', '-q', '-am', 'rename auth to login')
  const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  const c = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'old', line: 2, revision: set.ranges.committed!.from, text: 'Keep the check', section: 'committed', base: 'main' })
  expect(c).toMatchObject({ anchor: { path: 'src/auth.js', side: 'old', snippet: '  check(token)' }, state: 'open', placement: { kind: 'same', line: 2 } })
  // In the window it shows on the renamed file's old side.
  const byLine = commentsByLine([c], { path: 'src/login.js', oldPath: 'src/auth.js', section: 'committed', from: set.ranges.committed!.from, to: set.ranges.committed!.to, currentNew: true, currentOld: true })
  expect([...byLine.keys()]).toEqual(['old:2'])
})

test('a comment written before its file was renamed follows it to the new name', async () => {
  const { review, task } = await setup()
  write('src/auth.js', `${AUTH}// todo\n`)
  const before = (await review.changes('p', task.id, { kind: 'branch', base: 'main' })).tree
  const c = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 2, revision: before, text: 'Also check expiry', section: 'local' })
  git('mv', 'src/auth.js', 'src/login.js')
  write('src/login.js', `// Login\n${AUTH}// todo\n`)
  const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  expect(set.files.filter((f) => f.section === 'local')).toEqual([{ status: 'R', oldPath: 'src/auth.js', path: 'src/login.js', section: 'local' }])
  const [placed] = await review.comments('p', task.id, set.tree)
  expect(placed).toMatchObject({ id: c.id, state: 'open', placement: { kind: 'moved', line: 3, from: 2, path: 'src/login.js' } })
  // Shown on the renamed file's diff, and sent to the agent under its new name.
  const byLine = commentsByLine([placed], { path: 'src/login.js', oldPath: 'src/auth.js', section: 'local', from: set.ranges.local!.from, to: set.ranges.local!.to, currentNew: true, currentOld: true })
  expect([...byLine.keys()]).toEqual(['new:3'])
  const text = formatFixRequest(task, [placed], 'feat/login')
  expect(text).toMatch(/src\/login\.js:\n- line 3 \(moved from 2, now in src\/login\.js\)/)
  // Gone altogether, it's outdated, not pinned somewhere else.
  git('rm', '-q', '-f', 'src/login.js')
  expect((await review.comments('p', task.id))[0]).toMatchObject({ state: 'outdated' })
})

test('name-status output is read with renames as one entry, old path first', () => {
  expect(parseNameStatus('M\0a.txt\0R087\0old/x.ts\0new/x.ts\0A\0b.txt\0', 'local')).toEqual([
    { status: 'M', path: 'a.txt', section: 'local' },
    { status: 'R', oldPath: 'old/x.ts', path: 'new/x.ts', section: 'local' },
    { status: 'A', path: 'b.txt', section: 'local' }
  ])
})
