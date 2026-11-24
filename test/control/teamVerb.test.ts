import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { gitEnvFrom } from '../../src/core/git/args'
import { systemGit, type Git } from '../../src/core/git/service'
import { RpcRefusal } from '../../src/main/control/server'
import { readCheckout, withTeamVerb } from '../../src/main/control/teamVerb'
import { cleanEnv } from '../../src/main/sessions/env'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { NodeMessage } from '../../src/shared/contract'
import type { AgentStop } from '../../src/shared/agentStop'
import { claudeNode, groupNode, memoryStore, terminalNode } from './fakes'
import { patientGit, removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay team '))
})
afterEach(() => removeTemp(dir))

const NOW = new Date(2026, 10, 23, 15, 0, 0).getTime()

/** git answering from a table: each folder's rev-parse lines and its count ahead of main. */
function fakeGit(folders: Record<string, { lines: string; ahead?: number }>, calls: string[] = []): Git {
  return async (cwd, args) => {
    calls.push(`${cwd} ${args[0]}`)
    const f = folders[cwd]
    const r = { stderr: '', truncated: false, timedOut: false, missing: false }
    if (!f) return { ...r, code: 128, stdout: '' }
    if (args[0] === 'rev-parse') return { ...r, code: 0, stdout: f.lines }
    if (args[0] === 'rev-list' && args[2] === 'main..HEAD' && f.ahead !== undefined) return { ...r, code: 0, stdout: `${f.ahead}\n` }
    return { ...r, code: 128, stdout: '' }
  }
}

function setup(messages: NodeMessage[] = [], git: Git = fakeGit({})) {
  const store = memoryStore([
    claudeNode('lead'),
    groupNode('g', { title: 'Polish round 4', openedBy: 'lead' }),
    claudeNode('a', { title: 'r4-lead', openedBy: 'lead', parentId: 'g', cwd: 'C:/w/r4-lead' }),
    claudeNode('b', { title: 'r4-leftovers', openedBy: 'lead', parentId: 'g', cwd: 'C:/w/r4-leftovers', agent: 'codex' }),
    claudeNode('c', { title: 'Reviewer', openedBy: 'lead', cwd: 'C:/repo' }),
    claudeNode('someone', { title: 'Not mine', cwd: 'C:/repo' }),
    terminalNode('t', { openedBy: 'lead' })
  ])
  let clock = NOW - 600_000
  const tracker = createStatusTracker({ notify: () => {}, now: () => clock })
  tracker.apply('a', { type: 'hook', name: 'UserPromptSubmit' })
  clock = NOW - 120_000
  tracker.apply('b', { type: 'hook', name: 'StopFailure' })
  const stops = new Map<string, AgentStop>([['b', { kind: 'usage-limit', at: NOW - 120_000, until: NOW + 3_600_000, message: null } as unknown as AgentStop]])
  const base = async () => 'passed on'
  const verbs = withTeamVerb(base, { store, tracker, stops, messages: () => messages, git, now: () => NOW })
  return { verbs, store }
}

test('one line per agent the lead opened: status, stop, last report, branch and commits ahead', async () => {
  const messages: NodeMessage[] = [
    { from: 'a', to: 'lead', text: 'Started on wait --next.', at: NOW - 3_600_000 },
    { from: 'a', to: 'someone', text: 'not for the lead', at: NOW - 60_000 },
    { from: 'a', to: 'lead', text: '\nDone: commit abc123, wait --next and team.\nMore detail follows on many lines.', at: NOW - 300_000 }
  ]
  const git = fakeGit({
    'C:/w/r4-lead': { lines: 'C:/repo/.git/worktrees/r4-lead\nC:/repo/.git\nfeat/r4-lead\n', ahead: 3 },
    'C:/repo': { lines: '.git\n.git\nmain\n', ahead: 0 }
  })
  const { verbs } = setup(messages, git)
  const r = (await verbs('lead', 'team', {})) as { text: string; members: Array<Record<string, unknown>> }
  expect(r.members.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  const [a, b, c] = r.text.trim().split('\n').slice(1)
  expect(r.text.split('\n')[0]).toBe('Agents you opened (3):')
  expect(a).toBe('- r4-lead [a] working 10m | report 14:55 (5m ago): Done: commit abc123, wait --next and team. | feat/r4-lead +3 vs main, worktree r4-lead')
  expect(b).toMatch(/^- r4-leftovers \[b\] unknown 2m \| stopped: .+ \| no report yet \| r4-leftovers$/)
  expect(c).toBe('- Reviewer [c] unknown | no report yet | main +0 vs main, repo')
  expect(r.members[1]).toMatchObject({ agent: 'codex', stopped: expect.any(String) })
})

test('--group lists that group, by id or title; a gone group is refused', async () => {
  const { verbs } = setup()
  const r = (await verbs('lead', 'team', { group: 'Polish round 4' })) as { text: string; members: Array<{ id: string }> }
  expect(r.members.map((m) => m.id)).toEqual(['a', 'b'])
  expect(r.text).toMatch(/^Agents in "Polish round 4" \(2\):/)
  const e = (await verbs('lead', 'team', { group: 'old-group' }).catch((x: unknown) => x)) as Error
  expect(e).toBeInstanceOf(RpcRefusal)
  expect(e.message).toMatch(/Group "old-group" is gone/)
  await expect(verbs('lead', 'team', { group: 't' })).rejects.toThrow(/not a group/)
})

test('each folder is read once, and other verbs pass straight through', async () => {
  const calls: string[] = []
  const store = memoryStore([claudeNode('lead'), claudeNode('a', { openedBy: 'lead', cwd: 'C:/same' }), claudeNode('b', { openedBy: 'lead', cwd: 'C:/same' })])
  const verbs = withTeamVerb(async () => 'passed on', { store, tracker: createStatusTracker({ notify: () => {} }), messages: () => [], git: fakeGit({}, calls) })
  await verbs('lead', 'team', {})
  expect(calls).toEqual(['C:/same rev-parse'])
  expect(await verbs('lead', 'list', {})).toBe('passed on')
})

test('no agents is said, not left blank', async () => {
  const store = memoryStore([claudeNode('lead')])
  const verbs = withTeamVerb(async () => null, { store, tracker: createStatusTracker({ notify: () => {} }), messages: () => [], git: fakeGit({}) })
  expect(await verbs('lead', 'team', {})).toEqual({ members: [], text: 'Agents you opened: no agents.\n' })
})

test('reads a real checkout: its branch, a linked worktree, and commits ahead of main', async () => {
  const repo = join(dir, 'repo')
  const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', windowsHide: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe', windowsHide: true })
  g(repo, 'config', 'user.email', 'test@example.com')
  g(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'one')
  g(repo, 'add', '.')
  g(repo, 'commit', '-qm', 'one')
  const tree = join(dir, 'tree')
  g(repo, 'worktree', 'add', '-q', '-b', 'feat/x', tree)
  writeFileSync(join(tree, 'b.txt'), 'two')
  g(tree, 'add', '.')
  g(tree, 'commit', '-qm', 'two')
  const git = patientGit(systemGit(gitEnvFrom(cleanEnv(process.env, {}))))
  expect(await readCheckout(git, repo)).toEqual({ branch: 'main', ahead: 0, base: 'main', worktree: false })
  expect(await readCheckout(git, tree)).toEqual({ branch: 'feat/x', ahead: 1, base: 'main', worktree: true })
  expect(await readCheckout(git, dir)).toBeUndefined()
})
