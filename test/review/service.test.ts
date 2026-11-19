import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { sendToAgent } from '../../src/main/agentMessages'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createReviewGit } from '../../src/main/review/git'
import { createReviewService } from '../../src/main/review/service'
import { createReviewStore } from '../../src/main/review/store'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createTaskService } from '../../src/main/tasks/service'
import type { TaskRevision } from '../../src/shared/task'
import { claudeNode, fakeHost, memoryStore } from '../control/fakes'

let dir: string
let repo: string
const rev: TaskRevision = { revision: 'abc', fingerprint: 'f', uncommitted: false }
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true })
const write = (path: string, text: string): void => {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), text)
}
const AUTH = ['export function login(token) {', '  check(token)', '  return session(token)', '}', ''].join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay-review-'))
  repo = join(dir, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  write('README.md', 'base\n')
  write('src/auth.js', 'export function login(token) {\n  return session(token)\n}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('switch', '-q', '-c', 'feat/login')
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

async function setup(opts: { status?: 'idle' | 'working' } = {}) {
  const nodes = [claudeNode('builder', { projectId: 'p', cwd: repo, title: 'Builder' }), claudeNode('helper', { projectId: 'p', cwd: repo, title: 'Helper' })]
  const store = memoryStore(nodes)
  store.dispatch({ op: 'addProject', project: { id: 'p', name: 'P', folder: repo, viewport: { x: 0, y: 0, zoom: 1 } } })
  const tasks = createTaskService(store, dir, async () => {}, async () => rev)
  const task = await tasks.create('p', { brief: 'Validate login tokens', acceptanceCriteria: ['Bad tokens fail'], assignedSessionIds: ['builder'], cwd: repo, requiredChecks: [], dependsOn: [] })
  await tasks.submit('p', task.id, 'builder', 'Added token checks')
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  for (const id of ['builder', 'helper']) {
    host.running.add(id)
    tracker.apply(id, { type: 'launched' })
    tracker.apply(id, { type: 'hook', name: 'SessionStart' })
    if (opts.status === 'working') tracker.apply(id, { type: 'hook', name: 'UserPromptSubmit' })
  }
  const queue = createSendQueue({ host, tracker, exists: () => true, timing: { enterDelayMs: 5, settleMs: 50 } })
  const file = join(dir, 'data', 'review-inbox.json')
  const make = () => createReviewService({ store, tasks, data: createReviewStore(file, () => {}), git: createReviewGit(join(dir, 'data', 'review-objects')), send: (id, text) => sendToAgent({ store, status: (i) => tracker.get(i), queue }, id, text) })
  const review = make()
  /** What the window shows after loading the branch diff: what a review action is about. */
  const shownNow = async (r = review) => {
    const set = await r.changes('p', task.id, { kind: 'branch', base: 'main' })
    return { tree: set.tree, head: set.head, base: set.base?.name, mergeBase: set.base?.mergeBase }
  }
  return { store, tasks, task, tracker, host, file, make, review, shownNow }
}

test('committed work and local changes are listed separately, against the merge-base with the chosen base', async () => {
  const { review, task } = await setup()
  write('src/auth.js', AUTH)
  git('commit', '-q', '-am', 'check tokens')
  // The base moves on after the branch started. Its new work isn't the branch's.
  git('switch', '-q', 'main')
  write('BASE_ONLY.md', 'later on main\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'main moves')
  git('switch', '-q', 'feat/login')
  write('README.md', 'base\nlocal edit\n')
  write('notes/new.txt', 'untracked\n')
  const indexBefore = readFileSync(join(repo, '.git', 'index'))
  const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  expect(set.base?.mergeBase).toBe(git('merge-base', 'main', 'HEAD').trim())
  expect(set.files.filter((f) => f.section === 'committed').map((f) => f.path)).toEqual(['src/auth.js'])
  expect(set.files.filter((f) => f.section === 'local').map((f) => `${f.status} ${f.path}`).sort()).toEqual(['A notes/new.txt', 'M README.md'])
  expect(set.files.some((f) => f.path === 'BASE_ONLY.md')).toBe(false)
  // A snapshot never touches the checkout's own index or status.
  expect(readFileSync(join(repo, '.git', 'index')).equals(indexBefore)).toBe(true)
  expect(git('status', '--porcelain')).toContain('?? notes/')
  const diff = await review.fileDiff('p', task.id, set.ranges.committed!, 'src/auth.js')
  expect(diff.text).toContain('+  check(token)')
})

test('committed changes stay reviewable once everything is committed', async () => {
  const { review, task } = await setup()
  write('src/auth.js', AUTH)
  git('commit', '-q', '-am', 'check tokens')
  const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  expect(set.files).toEqual([{ path: 'src/auth.js', status: 'M', section: 'committed' }])
  expect(set.ranges.local).toBeDefined()
})

test('on the base branch itself there is no committed work to separate, and it says so', async () => {
  const { review, task } = await setup()
  git('switch', '-q', 'main')
  const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  expect(set.ranges.committed).toBeUndefined()
  expect(set.notes.join(' ')).toMatch(/no committed work/)
})

test('comments survive a restart, with their anchors', async () => {
  const { review, task, make, file } = await setup()
  write('src/auth.js', AUTH)
  git('commit', '-q', '-am', 'check tokens')
  const head = git('rev-parse', 'HEAD').trim()
  const added = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 2, revision: head, text: 'Also check expiry', section: 'committed', base: 'main' })
  expect(added.anchor).toMatchObject({ snippet: '  check(token)', revisionKind: 'commit', revision: head, before: ['export function login(token) {'] })
  expect(existsSync(file)).toBe(true)
  const again = make()
  const list = await again.comments('p', task.id)
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ text: 'Also check expiry', state: 'open', placement: { kind: 'same', line: 2 } })
})

test('a comment whose code moved is re-anchored, and one whose code changed is flagged outdated', async () => {
  const { review, task } = await setup()
  write('src/auth.js', AUTH)
  const tree = (await review.changes('p', task.id, { kind: 'branch', base: 'main' })).tree
  const c = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 2, revision: tree, text: 'Also check expiry', section: 'local' })
  expect(c.anchor.revisionKind).toBe('snapshot')
  write('src/auth.js', `// Login\n// Tokens\n${AUTH}`)
  expect((await review.comments('p', task.id))[0]).toMatchObject({ state: 'open', placement: { kind: 'moved', line: 4, from: 2 } })
  write('src/auth.js', AUTH.replace('check(token)', 'verify(token)'))
  expect((await review.comments('p', task.id))[0]).toMatchObject({ state: 'outdated', placement: { kind: 'outdated' } })
  await review.setCommentStatus('p', c.id, 'resolved')
  expect((await review.comments('p', task.id))[0].state).toBe('resolved')
})

test('changes since the last review compare with the recorded snapshot, not a time window', async () => {
  const { review, task, shownNow } = await setup()
  write('src/auth.js', AUTH)
  write('scratch.txt', 'seen at review\n')
  const { mark } = await review.markReviewed('p', task.id, await shownNow())
  expect(mark.tree).toMatch(/^[0-9a-f]{40}$/)
  write('README.md', 'base\nafter review\n')
  const set = await review.changes('p', task.id, { kind: 'since-review' })
  expect(set.review?.id).toBe(mark.id)
  expect(set.files).toEqual([{ path: 'README.md', status: 'M', section: 'since-review' }])
  // Committing what was already reviewed changes nothing about what's new since.
  git('add', '-A')
  git('commit', '-q', '-m', 'commit reviewed work')
  expect((await review.changes('p', task.id, { kind: 'since-review' })).files.map((f) => f.path)).toEqual(['README.md'])
})

test('rewritten history since a review is said, and the comparison stays exact', async () => {
  const { review, task, shownNow } = await setup()
  write('src/auth.js', AUTH)
  git('commit', '-q', '-am', 'one')
  await review.markReviewed('p', task.id, await shownNow())
  git('commit', '-q', '--amend', '-m', 'one, reworded')
  const set = await review.changes('p', task.id, { kind: 'since-review' })
  expect(set.notes.join(' ')).toMatch(/History was rewritten/)
  expect(set.files).toEqual([])
})

test('there is no "since last review" without a recorded review', async () => {
  const { review, task } = await setup()
  await expect(review.changes('p', task.id, { kind: 'since-review' })).rejects.toThrow(/No review is recorded/)
})

test('a moved base since the last review is pointed out', async () => {
  const { review, task, shownNow } = await setup()
  write('src/auth.js', AUTH)
  git('commit', '-q', '-am', 'one')
  await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  await review.markReviewed('p', task.id, await shownNow())
  git('switch', '-q', 'main')
  write('BASE.md', 'x\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'main moves')
  git('switch', '-q', 'feat/login')
  git('rebase', '-q', 'main')
  const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  expect(set.notes.join(' ')).toMatch(/The base moved since your last review/)
})

test('request fixes queues open comments for the task\'s agent while it is busy, and delivers them once idle', async () => {
  const { review, task, tracker, host } = await setup({ status: 'working' })
  write('src/auth.js', AUTH)
  git('commit', '-q', '-am', 'one')
  const head = git('rev-parse', 'HEAD').trim()
  const open = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 2, revision: head, text: 'Also check expiry', section: 'committed', base: 'main' })
  const done = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 3, revision: head, text: 'Fine already', section: 'committed', base: 'main' })
  await review.setCommentStatus('p', done.id, 'resolved')
  await expect(review.requestFixes('p', task.id, 'helper')).rejects.toThrow(/assigned to this task/)
  const r = await review.requestFixes('p', task.id, 'builder')
  expect(r).toEqual({ queued: true, sent: 1, to: 'Builder', recorded: true, changedSince: false })
  expect(host.writes).toEqual([])
  tracker.apply('builder', { type: 'hook', name: 'Stop' })
  await vi.waitFor(() => expect(host.writes.some(([id, d]) => id === 'builder' && d.includes('Also check expiry'))).toBe(true))
  const typed = host.writes.filter(([id]) => id === 'builder').map(([, d]) => d).join('')
  expect(typed).toContain(`patchbay task submit --task ${task.id}`)
  expect(typed).not.toContain('Fine already')
  expect(host.writes.some(([id]) => id === 'helper')).toBe(false)
  // What was reviewed when fixes were asked for is recorded, and the sent comment says when it went.
  const set = await review.changes('p', task.id, { kind: 'since-review' })
  expect(set.review?.reason).toBe('fixes-requested')
  expect((await review.comments('p', task.id)).find((c) => c.id === open.id)?.sentAt).toBeTypeOf('number')
})

test('with no open comments there is nothing to request', async () => {
  const { review, task } = await setup()
  await expect(review.requestFixes('p', task.id, 'builder')).rejects.toThrow(/no open comments/)
})

test('the inbox lists submitted tasks with their checkout, and never puts a shared checkout down to one agent', async () => {
  const solo = await setup()
  const [item] = await solo.review.inbox('p')
  expect(item.view.task.brief).toBe('Validate login tokens')
  expect(item.branch).toBe('feat/login')
  expect(item.base).toBe('main')
  expect(item.agents).toEqual([{ id: 'builder', title: 'Builder' }])
  // "Helper" works in the same folder, so even here the diff isn't Builder's alone.
  expect(item.attribution.sole).toBe(false)
  expect(item.attribution.others).toEqual(['Helper'])
  expect(item.attribution.note).toMatch(/not any one agent's/)
})

test('a damaged review file is moved aside, not lost, and the inbox starts empty', () => {
  const file = join(dir, 'review-inbox.json')
  writeFileSync(file, '{ not json')
  const logged: string[] = []
  const store = createReviewStore(file, (l) => logged.push(l))
  expect(store.get().comments).toEqual([])
  expect(readdirSync(dir).some((n) => n.startsWith('review-inbox.json.bad-'))).toBe(true)
  expect(logged.join('')).toMatch(/kept as/)
})

test('comments can only be added on a line that is in the file at that revision', async () => {
  const { review, task } = await setup()
  const head = git('rev-parse', 'HEAD').trim()
  await expect(review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 99, revision: head, text: 'x', section: 'committed', base: 'main' })).rejects.toThrow(/isn't in/)
  await expect(review.addComment('p', task.id, { path: '../outside.txt', side: 'new', line: 1, revision: head, text: 'x', section: 'committed', base: 'main' })).rejects.toThrow(/Not a file/)
  await expect(review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 1, revision: 'HEAD', text: 'x', section: 'committed', base: 'main' })).rejects.toThrow(/Not a revision/)
})

test('what is recorded as reviewed is what the window showed, not files changed after it loaded', async () => {
  const { review, task, shownNow } = await setup()
  write('src/auth.js', AUTH)
  const shown = await shownNow()
  // Another agent edits after the person loaded the diff, before they press Mark reviewed.
  write('src/token.js', 'export const late = 1\n')
  const { mark, changedSince } = await review.markReviewed('p', task.id, shown)
  expect(mark.tree).toBe(shown.tree)
  expect(changedSince).toBe(true)
  const since = await review.changes('p', task.id, { kind: 'since-review' })
  expect(since.files.map((f) => f.path)).toEqual(['src/token.js'])
  await expect(review.markReviewed('p', task.id, { ...shown, tree: 'f'.repeat(40) })).rejects.toThrow(/no longer known/)
})

test('request fixes records the revision shown, so edits made while the agent was busy show as new', async () => {
  const { review, task, shownNow } = await setup({ status: 'working' })
  write('src/auth.js', AUTH)
  git('commit', '-q', '-am', 'one')
  await review.addComment('p', task.id, { path: 'src/auth.js', side: 'new', line: 2, revision: git('rev-parse', 'HEAD').trim(), text: 'x', section: 'committed', base: 'main' })
  const shown = await shownNow()
  write('src/auth.js', `${AUTH}// more\n`)
  const r = await review.requestFixes('p', task.id, 'builder', shown)
  expect(r).toMatchObject({ recorded: true, changedSince: true })
  expect((await review.changes('p', task.id, { kind: 'since-review' })).files.map((f) => f.path)).toEqual(['src/auth.js'])
})

test('a comment on a removed line is found against the "from" of the list it was written on', async () => {
  const { review, task, shownNow } = await setup()
  write('src/auth.js', AUTH.replace('  check(token)\n', '  check(token)\n  const secretValue = compute()\n'))
  git('commit', '-q', '-am', 'add secret')
  const head = git('rev-parse', 'HEAD').trim()
  // Removed again in the working folder: a removed line in the local list, whose "from" is HEAD.
  write('src/auth.js', AUTH)
  const local = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'old', line: 3, revision: head, text: 'Why remove this?', section: 'local' })
  expect(local).toMatchObject({ state: 'open', placement: { kind: 'same', line: 3 } })
  // A removed line in the since-review list, whose "from" is the recorded snapshot: it never changes.
  await review.markReviewed('p', task.id, await shownNow())
  write('src/auth.js', AUTH.replace('  return session(token)\n', ''))
  const since = await review.changes('p', task.id, { kind: 'since-review' })
  const from = since.ranges['since-review']!.from
  const gone = await review.addComment('p', task.id, { path: 'src/auth.js', side: 'old', line: 3, revision: from, text: 'Keep the session', section: 'since-review' })
  expect(gone).toMatchObject({ state: 'open', placement: { kind: 'same', line: 3 } })
  // Committing moves HEAD past the local removal, so that comment's line is no longer in its "from".
  git('commit', '-q', '-am', 'drop both')
  const now = await review.comments('p', task.id)
  expect(now.find((c) => c.id === local.id)?.state).toBe('outdated')
  expect(now.find((c) => c.id === gone.id)?.state).toBe('open')
})

test("snapshots go to Patchbay's own object store, never into the repository", async () => {
  const { review, task } = await setup()
  const objects = join(repo, '.git', 'objects')
  const loose = (): number => readdirSync(objects).filter((d) => /^[0-9a-f]{2}$/.test(d)).reduce((n, d) => n + readdirSync(join(objects, d)).length, 0)
  const before = loose()
  write('big-untracked.bin', 'x'.repeat(100_000))
  write('src/auth.js', AUTH)
  const set = await review.changes('p', task.id, { kind: 'branch', base: 'main' })
  expect(set.files.map((f) => f.path)).toContain('big-untracked.bin')
  expect((await review.fileDiff('p', task.id, set.ranges.local!, 'src/auth.js')).text).toContain('check(token)')
  expect(loose()).toBe(before)
  expect(() => execFileSync('git', ['cat-file', '-e', set.tree], { cwd: repo, stdio: 'ignore' })).toThrow()
  expect(existsSync(join(dir, 'data', 'review-objects'))).toBe(true)
})

test('anchors keep long lines short, marks are capped per task, and records of deleted tasks go', async () => {
  const { review, task, shownNow, store, file } = await setup()
  write('min.js', `${'a'.repeat(100_000)}\n`)
  git('add', '-A')
  git('commit', '-q', '-m', 'minified')
  const head = git('rev-parse', 'HEAD').trim()
  const c = await review.addComment('p', task.id, { path: 'min.js', side: 'new', line: 1, revision: head, text: 'too long', section: 'committed', base: 'main' })
  expect(c.anchor.snippet.length).toBeLessThan(500)
  expect(c.state).toBe('open')
  const shown = await shownNow()
  for (let i = 0; i < 22; i++) await review.markReviewed('p', task.id, shown)
  expect(JSON.parse(readFileSync(file, 'utf8')).marks).toHaveLength(20)
  expect(readFileSync(file).length).toBeLessThan(50_000)
  // The task goes from the project's records: its comments, marks and base go at the next listing.
  const project = store.get().projects.find((p) => p.id === 'p')!
  store.dispatch({ op: 'setTasks', projectId: 'p', tasks: { ...project.tasks!, tasks: [] } })
  await review.inbox('p')
  const after = JSON.parse(readFileSync(file, 'utf8'))
  expect([after.comments.length, after.marks.length, Object.keys(after.bases).length]).toEqual([0, 0, 0])
}, 60_000)

test('a terminal open in the checkout counts too: the diff is not put down to the agent alone', async () => {
  const { review, store } = await setup()
  store.dispatch({ op: 'removeNodes', ids: ['helper'], at: Date.now() })
  expect((await review.inbox('p'))[0].attribution.sole).toBe(true)
  store.dispatch({ op: 'addNode', node: { id: 'shell', kind: 'terminal', title: 'Dev shell', cwd: join(repo, 'src'), x: 0, y: 0, width: 10, height: 10, parentId: null, projectId: 'p' } })
  const [item] = await review.inbox('p')
  expect(item.attribution.sole).toBe(false)
  expect(item.attribution.others).toEqual(['Dev shell'])
})

test('a review file of another shape is moved aside rather than overwritten, and a damaged one is copied first', () => {
  const file = join(dir, 'review-inbox.json')
  writeFileSync(file, JSON.stringify({ version: 2, comments: { a: 1 } }))
  const store = createReviewStore(file, () => {})
  expect(store.get().comments).toEqual([])
  expect(existsSync(file)).toBe(false)
  expect(readdirSync(dir).filter((n) => n.startsWith('review-inbox.json.bad-'))).toHaveLength(1)
  const other = join(dir, 'other.json')
  writeFileSync(other, JSON.stringify({ version: 1, comments: [{ id: 'broken' }], marks: [] }))
  createReviewStore(other, () => {})
  expect(readdirSync(dir).filter((n) => n.startsWith('other.json.bad-'))).toHaveLength(1)
  expect(existsSync(other)).toBe(true)
})
