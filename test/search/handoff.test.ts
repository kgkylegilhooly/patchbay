import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHandoff, type HandoffInput } from '../../src/core/search/handoff'
import { handoffMarkdown, handoffPrompt, stamp } from '../../src/core/search/handoffText'
import { transcriptEvents } from '../../src/core/search/transcriptEvents'
import { claudeResult, claudeSays, claudeTool, claudeUser, lines } from './fixtures'

const T = Date.UTC(2026, 10, 18, 9, 0)
const repo = join('C:', 'work', 'repo')

function input(text: string, over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    title: 'Fix the parser',
    agent: 'claude',
    cwd: repo,
    projectId: 'p1',
    projectName: 'Patchbay',
    transcriptPath: join(repo, 't.jsonl'),
    transcript: transcriptEvents(text),
    sourceBusy: false,
    git: { root: repo, changed: ['src/parse.ts', 'README.md'] },
    exists: () => true,
    now: T + 3600_000,
    ...over
  }
}

const sectionOf = (d: ReturnType<typeof buildHandoff>, id: string) => d.sections.find((s) => s.id === id)!

const full = lines(
  claudeUser('Fix the unicode bug in the parser', T),
  claudeSays('Looking. I decided to read code points instead of UTF-16 units.', T + 1000),
  claudeTool('e1', 'Edit', { file_path: join(repo, 'src', 'parse.ts') }, T + 2000),
  claudeResult('e1', 'The file has been updated.', T + 2100),
  claudeTool('e2', 'Write', { file_path: join(repo, 'src', 'gone.ts') }, T + 2500),
  claudeResult('e2', 'File created.', T + 2600),
  claudeTool('b1', 'Bash', { command: 'npx vitest run' }, T + 3000),
  claudeResult('b1', 'Tests 12 passed', T + 4000),
  claudeUser('Also keep the old API', T + 5000),
  claudeSays('Done. Fixed the parser.\n- [ ] Update the changelog\nNext step: run the acceptance script.', T + 6000)
)

describe('handoff', () => {
  it('is built from the conversation, with every section found', () => {
    const d = buildHandoff(input(full, { exists: (p) => !p.endsWith('gone.ts') }))
    expect(d.sections.map((s) => s.id)).toEqual(['objective', 'decisions', 'changed', 'verification', 'remaining', 'sources'])
    expect(sectionOf(d, 'objective').text).toContain('Fix the unicode bug in the parser')
    expect(sectionOf(d, 'objective').text).toContain('- Also keep the old API')
    expect(sectionOf(d, 'decisions').text).toContain('I decided to read code points instead of UTF-16 units.')
    const changed = sectionOf(d, 'changed')
    expect(changed.text).toContain('src/parse.ts (edited once')
    expect(changed.text).toContain('uncommitted change now')
    expect(changed.text).toMatch(/src\/gone\.ts .*\[Stale: missing on disk now\]/)
    expect(changed.text).toContain('- README.md')
    expect(changed.evidence).toBe('stale')
    const verification = sectionOf(d, 'verification')
    expect(verification.text).toContain('`npx vitest run`: passed')
    expect(verification.evidence).toBe('found')
    expect(sectionOf(d, 'remaining').text).toContain('- [ ] Update the changelog')
    expect(sectionOf(d, 'remaining').text).toContain('Next step: run the acceptance script.')
    expect(sectionOf(d, 'sources').text).toContain('(4 messages, last ')
    expect(sectionOf(d, 'sources').text).toContain('without AI')
  })

  it('marks a check that ran before later edits as stale', () => {
    const text = lines(claudeUser('go', T), claudeTool('b1', 'Bash', { command: 'npm run typecheck' }, T + 1), claudeResult('b1', 'ok', T + 2), claudeTool('e1', 'Edit', { file_path: join(repo, 'a.ts') }, T + 3))
    const v = sectionOf(buildHandoff(input(text)), 'verification')
    expect(v.evidence).toBe('stale')
    expect(v.text).toContain('[Stale: files were edited after this ran]')
  })

  it('says a check has no recorded outcome rather than guessing one', () => {
    const text = lines(claudeUser('go', T), claudeTool('b1', 'Bash', { command: 'cargo test' }, T + 1))
    const v = sectionOf(buildHandoff(input(text)), 'verification')
    expect(v.text).toContain('outcome not recorded')
    expect(v.evidence).toBe('partial')
  })

  it('marks missing evidence instead of filling it in', () => {
    const d = buildHandoff(input(lines(claudeUser('Just look around', T), claudeSays('I looked around the code.', T + 1))))
    for (const id of ['decisions', 'changed', 'verification']) {
      expect(sectionOf(d, id).evidence).toBe('missing')
      expect(sectionOf(d, id).text).toMatch(/^\[Missing: /)
    }
    const remaining = sectionOf(d, 'remaining')
    expect(remaining.evidence).toBe('partial')
    expect(remaining.text).toContain('[Missing: the agent did not say what is left.]')
    expect(remaining.text).toContain('I looked around the code.')
  })

  it('marks every transcript section missing when the transcript is gone', () => {
    const d = buildHandoff(input('', { transcript: { missing: 'it was removed' } }))
    for (const s of d.sections) expect(s.evidence).toBe('missing')
    expect(sectionOf(d, 'objective').text).toBe('[Missing: the transcript could not be read (it was removed).]')
  })

  it('marks the whole handoff possibly stale while the source agent is still working, and notes a half-written line', () => {
    const d = buildHandoff(input(full + claudeSays('half', T + 9).slice(0, 20), { sourceBusy: true }))
    const sources = sectionOf(d, 'sources')
    expect(sources.evidence).toBe('stale')
    expect(sources.text).toContain('[Stale: the source agent was still working')
    expect(sources.text).toContain('still being written')
  })

  it('says when git status is not known', () => {
    const d = buildHandoff(input(full, { git: { unavailable: 'not a git repository' } }))
    expect(sectionOf(d, 'changed').text).toContain('Git status unavailable: not a git repository')
  })

  it('puts sections from evidence providers before the sources', () => {
    const d = buildHandoff(input(full, { extra: [{ id: 'task', title: 'Task outcome', text: 'Accepted', evidence: 'found' }] }))
    expect(d.sections.map((s) => s.id)).toEqual(['objective', 'decisions', 'changed', 'verification', 'remaining', 'task', 'sources'])
  })

  it('is the same every time for the same source', () => {
    expect(buildHandoff(input(full))).toEqual(buildHandoff(input(full)))
  })

  it("starts the next agent with the person's edited text", () => {
    const d = buildHandoff(input(full))
    const edited = d.sections.map((s) => (s.id === 'remaining' ? { ...s, text: 'Only the changelog is left.' } : s))
    const prompt = handoffPrompt(d, edited, 'codex')
    expect(prompt).toContain('earlier Claude Code conversation, "Fix the parser"')
    expect(prompt).toContain('in Codex')
    expect(prompt).toContain('## Remaining work\n\nOnly the changelog is left.')
    expect(prompt).not.toContain('Update the changelog')
    expect(handoffMarkdown('X', [{ title: 'Empty', text: '  ' }])).toContain('## Empty\n\n(empty)')
    expect(stamp(T)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/)
  })
})
