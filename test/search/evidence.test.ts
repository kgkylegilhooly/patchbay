import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHandoff, isCheckCommand, type HandoffInput } from '../../src/core/search/handoff'
import { transcriptEvents } from '../../src/core/search/transcriptEvents'
import type { SearchEntry, SourceWindow } from '../../src/core/search/types'
import { createSearchEngine } from '../../src/main/search/engine'
import { matchPage, turnPage } from '../../src/renderer/searchUi'
import { claudeResult, claudeTool, claudeUser, iso, lines } from './fixtures'

const T = Date.UTC(2026, 10, 19, 9, 0)
const repo = join('C:', 'work', 'repo')
const file = (name: string): string => join(repo, 'src', name)

function handoff(text: string, over: Partial<HandoffInput> = {}) {
  const d = buildHandoff({
    title: 'Work', agent: 'claude', cwd: repo, transcriptPath: join(repo, 't.jsonl'), transcript: transcriptEvents(text), sourceBusy: false,
    git: { root: repo, changed: ['src/a.ts'] }, exists: () => true, now: T + 3600_000, ...over
  })
  return { section: (id: string) => d.sections.find((s) => s.id === id)! }
}

/** Claude's notice that a background command ended, as it appears in a transcript line. */
const notice = (toolUseId: string, status: string, code: number | null, at: number): string =>
  JSON.stringify({
    type: 'user', isMeta: true, timestamp: iso(at),
    message: { role: 'user', content: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command "npm test" ${status}${code === null ? '' : ` (exit code ${code})`}</summary>\n</task-notification>` }
  })
const launched = (id: string, at: number): string => claudeResult(id, 'Command running in background with ID: b1. Output is being written to: C:\\t\\b1.output', at)

describe('H1: a command started in the background has no outcome until it ends', () => {
  it('is not a passed check when it was only started', () => {
    const v = handoff(lines(claudeUser('go', T), claudeTool('t1', 'Bash', { command: 'npm test', run_in_background: true }, T + 1), launched('t1', T + 2))).section('verification')
    expect(v.text).toContain('`npm test`: ran in the background; no outcome recorded')
    expect(v.text).not.toContain('passed')
    expect(v.evidence).toBe('partial')
  })

  it('takes its outcome from the notice that it ended', () => {
    const failed = handoff(lines(claudeUser('go', T), claudeTool('t1', 'Bash', { command: 'npm test', run_in_background: true }, T + 1), launched('t1', T + 2), notice('t1', 'completed', 1, T + 3))).section('verification')
    expect(failed.text).toContain('`npm test`: failed')
    expect(failed.note).toBe('last check failed')
    const passed = handoff(lines(claudeUser('go', T), claudeTool('t1', 'Bash', { command: 'npm test', run_in_background: true }, T + 1), launched('t1', T + 2), notice('t1', 'completed', 0, T + 3))).section('verification')
    expect(passed.text).toContain('`npm test`: passed')
    const killed = handoff(lines(claudeUser('go', T), claudeTool('t1', 'Bash', { command: 'npm test' }, T + 1), launched('t1', T + 2), notice('t1', 'killed', null, T + 3))).section('verification')
    expect(killed.text).toContain('`npm test`: failed')
  })

  it('takes its outcome from BashOutput once it says the command ended', () => {
    const text = lines(
      claudeUser('go', T),
      claudeTool('t1', 'Bash', { command: 'npx vitest run' }, T + 1),
      launched('t1', T + 2),
      claudeTool('o1', 'BashOutput', { bash_id: 'b1' }, T + 3),
      claudeResult('o1', '<status>running</status>', T + 4),
      claudeTool('o2', 'BashOutput', { bash_id: 'b1' }, T + 5),
      claudeResult('o2', '<status>completed</status><exit_code>0</exit_code><stdout>Tests 9 passed</stdout>', T + 6)
    )
    const [cmd] = transcriptEvents(text).events.filter((e) => e.kind === 'command')
    expect(cmd).toMatchObject({ command: 'npx vitest run', ok: true, background: true })
  })
})

describe('M1: only commands that run a check count as verification', () => {
  it.each([
    ['git diff -- test/search/handoff.test.ts', false],
    ['cat test/search/handoff.test.ts', false],
    ['grep -rn "test" src', false],
    ['echo build done', false],
    ['npm test', true],
    ['npm run typecheck', true],
    ['npm install', false],
    ['npx vitest run test/search', true],
    ['cd /c/repo && npx.cmd tsc --noEmit -p tsconfig.json', true],
    ['timeout 300 node test/acceptance/host.cjs --only=x', true],
    ['node scripts/release.cjs', false],
    ['cargo test --all', true],
    ['go vet ./...', true],
    ['python -m pytest -q', true],
    ['VITE_X=1 pnpm lint', true]
  ])('%s → %s', (command, expected) => {
    expect(isCheckCommand(command)).toBe(expected)
  })

  it('keeps a check stale when only an inspection ran after the edit that followed it', () => {
    const v = handoff(
      lines(
        claudeUser('go', T),
        claudeTool('c1', 'Bash', { command: 'npx vitest run' }, T + 1),
        claudeResult('c1', 'Tests 3 passed', T + 2),
        claudeTool('e1', 'Edit', { file_path: file('a.ts') }, T + 3),
        claudeResult('e1', 'The file has been updated.', T + 4),
        claudeTool('d1', 'Bash', { command: 'git diff -- test/search/handoff.test.ts' }, T + 5),
        claudeResult('d1', 'diff --git ...', T + 6)
      )
    ).section('verification')
    expect(v.evidence).toBe('stale')
    expect(v.text).not.toContain('git diff')
  })
})

describe('M2: an edit counts as a change only when its result says it was made', () => {
  it('lists a failed edit as not changed, and lets it make nothing stale', () => {
    const h = handoff(
      lines(
        claudeUser('go', T),
        claudeTool('c1', 'Bash', { command: 'npm test' }, T + 1),
        claudeResult('c1', 'ok', T + 2),
        claudeTool('e1', 'Edit', { file_path: file('a.ts') }, T + 3),
        claudeResult('e1', 'String to replace not found in file.', T + 4, true)
      )
    )
    const changed = h.section('changed')
    expect(changed.evidence).toBe('missing')
    expect(changed.text).toContain('[Missing: the conversation records no completed file edits.]')
    expect(changed.text).toContain('Tried but failed, so not changed by these attempts:\n- src/a.ts (once)')
    expect(h.section('verification').evidence).toBe('found')
  })

  it('marks an edit with no result as unconfirmed, and still treats a check before it as stale', () => {
    const h = handoff(lines(claudeUser('go', T), claudeTool('c1', 'Bash', { command: 'npm test' }, T + 1), claudeResult('c1', 'ok', T + 2), claudeTool('e1', 'Write', { file_path: file('a.ts') }, T + 3)))
    const changed = h.section('changed')
    expect(changed.evidence).toBe('partial')
    expect(changed.text).toContain('src/a.ts (edit tried once, outcome not recorded')
    expect(h.section('verification').evidence).toBe('stale')
  })

  it("follows Codex's file change status and patch results", () => {
    const item = (status: string): string => JSON.stringify({ timestamp: iso(T), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { [file('a.ts')]: { type: 'update' } }, status } } })
    const patch = (id: string, path: string): string => JSON.stringify({ timestamp: iso(T), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: id, input: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch` } })
    const out = (id: string, output: string): string => JSON.stringify({ timestamp: iso(T), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output } })
    const edits = transcriptEvents(lines(item('failed'), item('declined'), item('completed'), item('in_progress'), patch('p1', 'b.ts'), out('p1', 'Success. Updated the following files:\nM b.ts'), patch('p2', 'c.ts'), out('p2', 'apply_patch verification failed: context not found'), patch('p3', 'd.ts')))
      .events.filter((e) => e.kind === 'edit')
      .map((e) => (e.kind === 'edit' ? e.ok : undefined))
    expect(edits).toEqual([false, false, true, null, true, false, null])
  })
})

describe('M3: every message of a long source can be reached', () => {
  it('pages from the match to both ends of a 1000-message source', async () => {
    const entries: SearchEntry[] = Array.from({ length: 1000 }, (_, i) => ({ text: `message ${i}`, at: T + i }))
    // A saved index, so no transcript is needed.
    const saved = { version: 1, docs: [{ key: 'conv:x', kind: 'conversation', title: 'Long', ref: { type: 'text' }, at: T, entries }], projects: {} }
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'pb-pages-'))
    try {
      writeFileSync(join(dir, 'index.json'), JSON.stringify(saved))
      const fromSaved = createSearchEngine({ indexFile: join(dir, 'index.json') })
      const read = async (p: { from: number; count: number }): Promise<SourceWindow> => (await fromSaved.handle({ type: 'source', key: 'conv:x', ...p, focus: 500 })) as SourceWindow
      const seen = new Set<number>()
      const first = await read(matchPage(500))
      expect(first.start).toBe(485)
      first.entries.forEach((_, i) => seen.add(first.start + i))
      for (const way of ['earlier', 'later'] as const) {
        let page: SourceWindow = first
        for (let turns = 0; turns < 100; turns++) {
          const next = turnPage(page, way)
          if (!next) break
          const got = await read(next)
          // Every turn moves.
          expect(got.start).not.toBe(page.start)
          got.entries.forEach((_, i) => seen.add(got.start + i))
          page = got
        }
        expect(turnPage(page, way)).toBeNull()
      }
      expect(seen.size).toBe(1000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never hands back more than a page', async () => {
    const engine = createSearchEngine({ indexFile: null })
    expect(await engine.handle({ type: 'source', key: 'missing', from: 0, count: 10, focus: 0 })).toBeNull()
  })
})
