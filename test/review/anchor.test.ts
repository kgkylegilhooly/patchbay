import { expect, test } from 'vitest'
import {
  anchorAt,
  attribution,
  commentState,
  fileLines,
  formatFixRequest,
  placeAnchor,
  reviewEvidence,
  reviewQueue,
  sanitizeReviewData,
  type CommentView
} from '../../src/shared/reviewInbox'
import type { Task, TaskView } from '../../src/shared/task'

const file = ['import a', 'function login() {', '  check(token)', '  return ok', '}', 'export default login']
const anchor = anchorAt(file, 3)!

test('an anchor keeps the line, its text and the lines around it', () => {
  expect(anchor).toEqual({ line: 3, snippet: '  check(token)', before: ['import a', 'function login() {'], after: ['  return ok', '}'] })
  expect(anchorAt(file, 0)).toBeNull()
  expect(anchorAt(file, 7)).toBeNull()
  expect(fileLines('a\r\nb\r\n')).toEqual(['a', 'b'])
})

test('an unchanged line stays where it was', () => {
  expect(placeAnchor(anchor, file)).toEqual({ kind: 'same', line: 3 })
})

test('lines added above move a comment, and it says where from', () => {
  const now = ['// header', '// more', ...file]
  expect(placeAnchor(anchor, now)).toEqual({ kind: 'moved', line: 5, from: 3, contextChanged: false })
})

test('a distinctive line whose neighbours changed is re-anchored, saying the context changed', () => {
  const now = ['import b', 'function signIn() {', '  check(token)', '  return ok', '}']
  expect(placeAnchor(anchor, now)).toEqual({ kind: 'moved', line: 3, from: 3, contextChanged: true })
})

test('a changed or removed line is outdated, never re-pinned elsewhere', () => {
  expect(placeAnchor(anchor, ['import a', 'function login() {', '  verify(token)', '  return ok', '}'])).toMatchObject({ kind: 'outdated' })
  expect(placeAnchor(anchor, null)).toEqual({ kind: 'outdated', reason: 'The file is no longer there.' })
})

test('a line found in two places is outdated rather than guessed', () => {
  const now = ['  check(token)', 'x', '  check(token)']
  expect(placeAnchor(anchor, now)).toMatchObject({ kind: 'outdated' })
})

test('a plain line like a closing brace needs its context to be found again', () => {
  const brace = anchorAt(file, 5)!
  expect(placeAnchor(brace, ['other', '}', 'stuff'])).toMatchObject({ kind: 'outdated' })
})

test('resolved wins over outdated, and outdated over open', () => {
  expect(commentState({ status: 'resolved' }, { kind: 'outdated', reason: 'x' })).toBe('resolved')
  expect(commentState({ status: 'open' }, { kind: 'outdated', reason: 'x' })).toBe('outdated')
  expect(commentState({ status: 'open' }, { kind: 'moved', line: 2, from: 1, contextChanged: false })).toBe('open')
})

const comment = (over: Partial<CommentView>): CommentView => ({
  id: 'c', projectId: 'p', taskId: 't', text: 'Check expiry too', status: 'open', createdAt: 1,
  anchor: { path: 'src/auth.ts', side: 'new', revision: 'a'.repeat(40), revisionKind: 'commit', ...anchor },
  placement: { kind: 'same', line: 3 }, state: 'open', ...over
})

test('a fix request lists unresolved comments by file, says which are outdated, and leaves resolved ones out', () => {
  const text = formatFixRequest({ id: 'task-1', brief: 'Fix login' }, [
    comment({ id: '1' }),
    comment({ id: '2', text: 'Rename this', placement: { kind: 'outdated', reason: 'gone' }, state: 'outdated' }),
    comment({ id: '3', text: 'Already done', status: 'resolved', state: 'resolved' })
  ], 'feat/login at abc1234')
  expect(text).toContain('patchbay task submit --task task-1')
  expect(text).toContain('src/auth.ts:')
  expect(text).toContain('- line 3: `check(token)`')
  expect(text).toContain('Check expiry too')
  expect(text).toContain('this code changed since the comment')
  expect(text).not.toContain('Already done')
})

const task = (over: Partial<Task>): Task => ({
  id: 't', projectId: 'p', brief: 'b', acceptanceCriteria: ['c'], assignedSessionIds: ['a'], cwd: 'C:\\r', state: 'ready-for-review',
  requiredChecks: [], dependsOn: [], createdAt: 1, updatedAt: 1, submissionId: 's', acceptances: [], ...over
})
const view = (t: Task, extra: Partial<TaskView> = {}): TaskView => ({ task: t, attempts: [], readiness: { ready: true, reasons: [], warnings: [] }, ...extra })

test('the queue holds submitted work, ready or blocked, and nothing accepted, planned or unsubmitted', () => {
  const q = reviewQueue([
    view(task({ id: 'ready' })),
    view(task({ id: 'blocked', state: 'blocked' })),
    view(task({ id: 'accepted', state: 'accepted' })),
    view(task({ id: 'running', state: 'running', submissionId: undefined })),
    view(task({ id: 'blocked-unsubmitted', state: 'blocked', submissionId: undefined }))
  ])
  expect(q.map((v) => v.task.id).sort()).toEqual(['blocked', 'ready'])
})

test('evidence says where it came from: the agent, a recorded command, or CI, which is unavailable and never passing', () => {
  const t = task({ requiredChecks: [{ id: 'unit', command: 'npm test', cwd: 'C:\\r' }, { id: 'lint', command: 'npm run lint', cwd: 'C:\\r' }, { id: 'e2e', command: 'npm run e2e', cwd: 'C:\\r' }] })
  const rev = { revision: 'x', uncommitted: false, fingerprint: 'f' }
  const ran = (checkId: string, status: 'passed' | 'failed') => ({ id: checkId, taskId: 't', sessionId: 'a', kind: 'command' as const, checkId, command: t.requiredChecks.find((c) => c.id === checkId)!.command, cwd: 'C:\\r', startedAt: 1, endedAt: 2, exitCode: status === 'passed' ? 0 : 1, status, outputRef: 'o', revision: rev })
  const ev = reviewEvidence(view(t, {
    attempts: [{ id: 's', taskId: 't', sessionId: 'a', kind: 'agent-report', summary: 'Done, all good', startedAt: 1, endedAt: 1, revision: rev }, ran('unit', 'passed'), ran('lint', 'failed')],
    readiness: { ready: false, reasons: ['unit: stale or unknown revision', 'lint: missing or not passing', 'e2e: missing or not passing'], warnings: [] }
  }))
  expect(ev[0]).toMatchObject({ source: 'agent-report', summary: 'Done, all good' })
  expect(ev[0].label).toMatch(/written by the agent/)
  expect(ev.find((e) => e.source === 'command' && e.checkId === 'unit')).toMatchObject({ state: 'stale', detail: 'stale or unknown revision' })
  expect(ev.find((e) => e.source === 'command' && e.checkId === 'lint')).toMatchObject({ state: 'failed' })
  expect(ev.find((e) => e.source === 'command' && e.checkId === 'e2e')).toMatchObject({ state: 'not run' })
  const ci = ev.find((e) => e.source === 'ci')!
  expect(ci.state).toBe('unavailable')
  expect(ci.detail).toMatch(/not a pass/)
})

test("a diff is one agent's only when one agent works in the checkout", () => {
  expect(attribution(['Builder'], [])).toMatchObject({ sole: true })
  const shared = attribution(['Builder'], ['Reviewer'])
  expect(shared.sole).toBe(false)
  expect(shared.note).toMatch(/2 agents work in this checkout .*not any one agent's/)
  expect(attribution(['A', 'B'], []).sole).toBe(false)
  expect(attribution([], []).sole).toBe(false)
})

test('loading keeps good records and drops damaged ones one at a time', () => {
  const good = comment({})
  const { placement: _p, state: _s, ...stored } = good
  const { data, dropped } = sanitizeReviewData({ version: 1, comments: [stored, { id: 'bad' }], marks: [{ nope: 1 }], bases: { 'p/t': 'main', 'p/u': 3 } })
  expect(data.comments).toEqual([stored])
  expect(data.marks).toEqual([])
  expect(data.bases).toEqual({ 'p/t': 'main' })
  expect(dropped).toBe(3)
})

test('a comment shows on a diff line only where it was written, or where it is now in a diff of the code as it is now', async () => {
  const { commentsOnLine } = await import('../../src/renderer/reviewInboxUi')
  const rev = 'a'.repeat(40)
  const moved = comment({ placement: { kind: 'moved', line: 5, from: 3, contextChanged: false } })
  const at = (o: Partial<{ line: number; revision: string; current: boolean; side: 'new' | 'old' }>) => commentsOnLine([moved], { path: 'src/auth.ts', side: 'new', line: 3, revision: rev, current: false, ...o }).length
  expect(at({})).toBe(1)
  expect(at({ line: 5 })).toBe(0)
  expect(at({ revision: 'b'.repeat(40), line: 5, current: true })).toBe(1)
  expect(at({ revision: 'b'.repeat(40), line: 5, current: false })).toBe(0)
  expect(at({ side: 'old' })).toBe(0)
  const gone = comment({ placement: { kind: 'outdated', reason: 'x' }, state: 'outdated' })
  expect(commentsOnLine([gone], { path: 'src/auth.ts', side: 'new', line: 3, revision: 'b'.repeat(40), current: true })).toEqual([])
})
