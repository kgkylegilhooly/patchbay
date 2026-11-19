import { describe, expect, test } from 'vitest'
import {
  attemptPrompt,
  confirmCovers,
  readComparison,
  readComparisonFile,
  removalNeeds,
  startProblem,
  suggestBranches,
  tailOutput,
  verifyArgv,
  verifyStanding,
  type AttemptState,
  type SourceInfo,
  type StartComparison
} from '../../src/shared/compare'

const SHA = 'a'.repeat(40)
const clean: SourceInfo = { ok: true, repo: 'C:/r', source: 'C:/r', commit: SHA, branch: 'main', subject: 's', uncommitted: [], uncommittedMore: 0 }
const dirty: SourceInfo = { ...clean, uncommitted: ['a.txt', 'b.txt'], uncommittedMore: 0 }
const req = (over: Partial<StartComparison> = {}): StartComparison => ({
  projectId: 'p',
  source: 'C:/r',
  brief: 'Fix the login bug',
  base: SHA,
  leaveOutUncommitted: false,
  attempts: [
    { agent: 'claude', approach: '', branch: 'try/a' },
    { agent: 'codex', approach: 'smaller', branch: 'try/b' }
  ],
  verify: '',
  ...over
})

describe('start requests', () => {
  test('a clean checkout with a brief, a base and two distinct branches can start', () => {
    expect(startProblem(req(), clean)).toBeNull()
  })

  test('uncommitted changes in the source need the explicit choice to leave them out', () => {
    expect(startProblem(req(), dirty)).toMatch(/2 uncommitted changes.*leave them out/)
    expect(startProblem(req({ leaveOutUncommitted: true }), dirty)).toBeNull()
  })

  test('the base must be a full commit id, the one the dialog showed', () => {
    expect(startProblem(req({ base: 'HEAD' }), clean)).toMatch(/base commit/)
    expect(startProblem(req({ base: 'abc1234' }), clean)).toMatch(/base commit/)
  })

  test('each attempt needs its own valid branch and an agent', () => {
    expect(startProblem(req({ attempts: [{ agent: 'claude', approach: '', branch: 'x' }, { agent: 'claude', approach: '', branch: 'x' }] }), clean)).toMatch(/different branches/)
    expect(startProblem(req({ attempts: [{ agent: 'claude', approach: '', branch: '-x' }, { agent: 'claude', approach: '', branch: 'y' }] }), clean)).toMatch(/can't be a branch/)
    expect(startProblem(req({ attempts: [{ agent: 'claude', approach: '', branch: 'a..b' }, { agent: 'claude', approach: '', branch: 'y' }] }), clean)).toMatch(/can't be a branch/)
    expect(startProblem(req({ attempts: [{ agent: 'gpt' as never, approach: '', branch: 'x' }, { agent: 'claude', approach: '', branch: 'y' }] }), clean)).toMatch(/Claude Code or Codex/)
    expect(startProblem(req({ attempts: [req().attempts[0]] }), clean)).toMatch(/two attempts/)
  })

  test('an empty brief or an unreadable source is refused', () => {
    expect(startProblem(req({ brief: '  ' }), clean)).toMatch(/brief/)
    expect(startProblem(req(), { ok: false, reason: 'Not in a git repository: C:/x' })).toMatch(/Not in a git/)
  })

  test('the verification command never goes through a shell', () => {
    expect(verifyArgv('npm test')).toEqual({ ok: true, argv: ['npm', 'test'] })
    expect(verifyArgv('  ')).toEqual({ ok: true, argv: null })
    expect(verifyArgv('npm test && rm -rf x').ok).toBe(false)
    expect(startProblem(req({ verify: 'echo $HOME' }), clean)).toMatch(/without a shell/)
  })

  test('both attempts get the same brief; an approach is added after it', () => {
    expect(attemptPrompt(' Fix it ', '')).toBe('Fix it')
    expect(attemptPrompt('Fix it', 'use a map')).toBe('Fix it\n\nApproach for this attempt: use a map')
  })

  test('branch suggestions come from the brief', () => {
    expect(suggestBranches('Fix the login bug!')).toEqual({ a: 'try/fix-the-login-bug-a', b: 'try/fix-the-login-bug-b' })
    expect(suggestBranches('')).toEqual({ a: 'try/attempt-a', b: 'try/attempt-b' })
  })
})

describe('removal', () => {
  test('a clean worktree whose branch is kept needs no confirmation', () => {
    expect(removalNeeds({ head: SHA, uncommitted: 0, unmerged: 3 }, false)).toBeNull()
  })

  test('uncommitted changes, or unmerged commits on a branch being deleted, need confirmation', () => {
    expect(removalNeeds({ head: SHA, uncommitted: 2, unmerged: 3 }, false)).toEqual({ head: SHA, uncommitted: 2, unmerged: 0 })
    expect(removalNeeds({ head: SHA, uncommitted: 0, unmerged: 3 }, true)).toEqual({ head: SHA, uncommitted: 0, unmerged: 3 })
  })

  test('a confirmation only covers exactly what was shown', () => {
    const needs = { head: SHA, uncommitted: 2, unmerged: 0 }
    expect(confirmCovers(needs, undefined)).toBe(false)
    expect(confirmCovers(needs, { ...needs })).toBe(true)
    expect(confirmCovers(needs, { ...needs, uncommitted: 1 })).toBe(false)
    expect(confirmCovers(needs, { ...needs, head: 'b'.repeat(40) })).toBe(false)
  })
})

describe('verification standing', () => {
  const result = { argv: ['npm', 'test'], cwd: 'C:/w', exitCode: 0, startedAt: 1, durationMs: 5, output: '', truncated: false, timedOut: false, missing: false, head: SHA, changes: 'x' }
  const state = (head: string, changes: string): AttemptState => ({ ok: true, head, branch: 'b', commits: [], committed: [], uncommitted: [], fromBase: true, unmerged: 0, changes })

  test('not run, current, or run on an older state', () => {
    expect(verifyStanding({}, state(SHA, 'x')).kind).toBe('not-run')
    expect(verifyStanding({ verify: result }, state(SHA, 'x')).kind).toBe('current')
    expect(verifyStanding({ verify: result }, state('b'.repeat(40), 'x')).kind).toBe('older')
    expect(verifyStanding({ verify: result }, state(SHA, 'y')).kind).toBe('older')
  })

  test('unavailable when the worktree is gone or was removed', () => {
    expect(verifyStanding({}, { ok: false, gone: true, reason: 'gone' }).kind).toBe('unavailable')
    expect(verifyStanding({ removed: { at: 1, branchDeleted: false } }, null).kind).toBe('unavailable')
  })

  test('output keeps the end, without terminal colours', () => {
    expect(tailOutput('\x1b[2m> npm test\x1b[0m\r\nok')).toEqual({ output: '> npm test\nok', truncated: false })
    expect(tailOutput('abcdef', 3)).toEqual({ output: 'def', truncated: true })
  })
})

describe('the stored file', () => {
  const stored = {
    id: 'c1', projectId: 'p', title: 'T', brief: 'B', createdAt: 1, verify: ['npm', 'test'], extra: 'dropped',
    base: { commit: SHA, branch: 'main', source: 'C:/r', repo: 'C:/r', uncommitted: 'left-out' },
    attempts: [{ key: 'a', agent: 'claude', approach: '', prompt: 'B', branch: 'try/a', path: 'C:/w/a', nodeId: 'n1', groupId: 'g1', sessionId: 'dropped' }],
    chosen: { key: 'a', at: 2, head: SHA },
    taskId: 't1'
  }

  test('is read field by field, keeping the P1 task hook and dropping anything unknown', () => {
    const c = readComparison(stored)!
    expect(c).not.toHaveProperty('extra')
    expect(c.attempts[0]).not.toHaveProperty('sessionId')
    expect(c.base.uncommitted).toBe('left-out')
    expect(c.chosen).toEqual({ key: 'a', at: 2, head: SHA })
    expect(c.taskId).toBe('t1')
  })

  test('a choice of an attempt that is not there is dropped', () => {
    expect(readComparison({ ...stored, chosen: { key: 'b', at: 2, head: SHA } })!.chosen).toBeUndefined()
  })

  test('another schema is refused rather than read as empty', () => {
    expect(() => readComparisonFile({ schema: 2, comparisons: [] })).toThrow()
    expect(readComparisonFile({ schema: 1, comparisons: [stored, { nonsense: true }] })).toHaveLength(1)
  })
})
