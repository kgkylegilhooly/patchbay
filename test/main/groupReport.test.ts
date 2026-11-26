import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createGroupReportSaver, groupReportMarkdown, membersOf } from '../../src/main/groupReport'
import { memoryStore } from '../control/fakes'

// F66: after a team run, writing up what each member did meant opening each one. A group's report is one Markdown file.
const box = { x: 0, y: 0, width: 10, height: 10 }
const group = { ...box, id: 'g', kind: 'group', title: 'Release team', parentId: null, worktree: { path: 'C:\\wt\\release', branch: 'release-1.4', repo: 'C:\\repo' } }
const agent = (id: string, title: string, parentId = 'g') => ({ ...box, id, kind: 'claude', title, cwd: 'C:\\wt\\release', sessionId: 's', transcriptPath: `C:\\t\\${id}.jsonl`, after: [], parentId })
const at = new Date(2026, 10, 26, 18, 30)

test("a group's members are its agents at any depth, in canvas order; not terminals or another group's", () => {
  const inner = { ...group, id: 'g2', parentId: 'g', worktree: null }
  const nodes = [group, inner, agent('a', 'Changelog'), agent('b', 'Bump', 'g2'), { ...box, id: 't', kind: 'terminal', title: 'Shell', cwd: 'C:\\', parentId: 'g' }, agent('c', 'Other', 'elsewhere')] as never[]
  expect(membersOf(nodes, 'g').map((n) => n.id)).toEqual(['a', 'b'])
})

test('the report has each member: where it ran, its status, its last reply and the files it edited, then the commits', () => {
  const md = groupReportMarkdown(
    { title: 'Release team', worktree: { path: 'C:\\wt\\release', branch: 'release-1.4' } },
    [
      { title: 'Changelog', cwd: 'C:\\wt\\release', agent: 'Claude Code', status: 'Idle', reply: 'Wrote the 1.4 notes.\n\n- 12 PRs', files: ['CHANGELOG.md', 'docs/1.4.md'], uncommitted: ['docs/1.4.md'] },
      { title: 'Bump', cwd: 'C:\\wt\\release', agent: 'Codex', status: 'Working', reply: null, files: [], uncommitted: [] }
    ],
    ['a1b2c3d Bump version to 1.4.0', 'e4f5a6b Add 1.4 changelog'],
    at
  )
  expect(md).toBe(
    [
      '# Report: Release team',
      '',
      'Saved from Patchbay on 2026-11-26 18:30. 2 agents, on branch `release-1.4` in `C:\\wt\\release`.',
      '',
      '## Changelog',
      '',
      'Claude Code in `C:\\wt\\release` · Idle',
      '',
      '### Last reply',
      '',
      'Wrote the 1.4 notes.',
      '',
      '- 12 PRs',
      '',
      '### Files it edited (2)',
      '',
      '- `CHANGELOG.md`',
      '- `docs/1.4.md` (uncommitted)',
      '',
      '## Bump',
      '',
      'Codex in `C:\\wt\\release` · Working',
      '',
      'No reply yet.',
      '',
      'No files edited.',
      '',
      '## Commits only on `release-1.4` (2)',
      '',
      '- a1b2c3d Bump version to 1.4.0',
      '- e4f5a6b Add 1.4 changelog',
      ''
    ].join('\n')
  )
})

function saver(over: { pick?: string | null; nodes?: never[] } = {}) {
  const writes: Array<{ path: string; text: string }> = []
  const asked: string[] = []
  const save = createGroupReportSaver({
    store: memoryStore(over.nodes ?? ([group, agent('a', 'Changelog')] as never[])),
    home: 'C:\\Users\\me',
    system: ['C:\\Windows'],
    now: () => at,
    status: () => 'idle',
    files: {
      files: async () => ({ nodeId: 'a', cwd: 'C:\\wt\\release', files: [{ path: 'C:\\wt\\release\\CHANGELOG.md' }], turns: [], truncated: false, overlaps: {} }) as never,
      uncommitted: async () => []
    },
    readReply: async () => 'Done.',
    commits: async () => ['a1b2c3d Bump'],
    async pickFile(defaultPath) {
      asked.push(defaultPath)
      return over.pick === undefined ? 'C:\\wt\\release\\report.md' : over.pick
    },
    async writeFile(path, text) {
      writes.push({ path, text })
    }
  })
  return { save, writes, asked }
}

test('saving asks where, starting in the group folder, and writes the report', async () => {
  const s = saver()
  expect(await s.save('g')).toEqual({ ok: true, path: 'C:\\wt\\release\\report.md', members: 1 })
  expect(s.asked).toEqual([join('C:\\wt\\release', 'release-team-report.md')])
  expect(s.writes[0].text).toContain('- `CHANGELOG.md`')
  expect(s.writes[0].text).toContain('- a1b2c3d Bump')
})

test('it says why when there is nothing to report, the person cancels, or the place is not allowed', async () => {
  expect(await saver({ nodes: [group] as never[] }).save('g')).toEqual({ ok: false, reason: 'Release team has no agents to report on.' })
  expect(await saver().save('a')).toEqual({ ok: false, reason: 'That is not a group.' })
  expect(await saver({ pick: null }).save('g')).toEqual({ ok: false, cancelled: true, reason: 'Not saved.' })
  const system = saver({ pick: 'C:\\Windows\\r.md' })
  expect((await system.save('g')).ok).toBe(false)
  expect(system.writes).toEqual([])
})

test("a group's menu offers Save a report", async () => {
  const { nodeMenu } = await import('../../src/renderer/menus')
  const asked: string[] = []
  const c = new Proxy({} as import('../../src/renderer/menus').Commands, { get: (_t, key) => (key === 'saveGroupReport' ? (id: string) => asked.push(id) : () => {}) })
  const items = nodeMenu(c, group as never, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }).filter((e): e is import('../../src/renderer/menus').MenuItem => e !== 'separator')
  items.find((i) => i.id === 'save-report')!.run()
  expect(asked).toEqual(['g'])
})

test("the commits listed are only the branch's own, with no remote at all", async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { branchOnlyCommits } = await import('../../src/main/groupReport')
  const { systemGit } = await import('../../src/core/git/service')
  const { gitEnvFrom, NO_FSMONITOR } = await import('../../src/core/git/args')
  const repo = mkdtempSync(join(tmpdir(), 'pb-report-'))
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), '1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'Start')
    git('switch', '-q', '-c', 'release-1.4')
    for (const m of ['Add 1.4 changelog', 'Bump version to 1.4.0']) {
      writeFileSync(join(repo, 'a.txt'), `${m}\n`)
      git('commit', '-q', '-am', m)
    }
    const lines = await branchOnlyCommits(systemGit(gitEnvFrom(process.env as Record<string, string>), NO_FSMONITOR), repo)
    expect(lines?.map((l) => l.replace(/^\w+ /, ''))).toEqual(['Bump version to 1.4.0', 'Add 1.4 changelog'])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
