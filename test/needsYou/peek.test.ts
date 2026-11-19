import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { pendingToolOf, summarizeCall, tailLines } from '../../src/core/transcript/peek'
import { MESSAGE_MAX, peekSession } from '../../src/main/needsYou/peek'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasDoc } from '../../src/shared/model'

const says = (text: string): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const calls = (id: string, name: string, input: unknown): string => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const prompt = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

describe('the call an agent is waiting on', () => {
  test('the newest call with no result yet', () => {
    expect(pendingToolOf([prompt('go'), calls('1', 'Read', { file_path: '/a' }), result('1'), calls('2', 'Bash', { command: 'npm   test\n --run' })])).toEqual({ tool: 'Bash', summary: 'npm test --run' })
  })
  test('none once every call has its result, or a new prompt starts', () => {
    expect(pendingToolOf([calls('1', 'Bash', { command: 'ls' }), result('1'), says('done')])).toBeNull()
    expect(pendingToolOf([calls('1', 'Bash', { command: 'ls' }), prompt('never mind')])).toBeNull()
  })
  test('skips side conversations, broken lines and other entries', () => {
    const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 's', name: 'Bash', input: { command: 'x' } }] } })
    expect(pendingToolOf([side, '{"type":"assist', JSON.stringify({ type: 'summary' })])).toBeNull()
  })
  test("a question is worded as Claude's prompt words it", () => {
    expect(summarizeCall('AskUserQuestion', { questions: [{ question: 'Which plan?' }] })).toBe('Which plan?')
    expect(summarizeCall('Edit', { file_path: '/src/a.ts', old_string: 'x' })).toBe('/src/a.ts')
    expect(summarizeCall('Mystery', {})).toBe('')
    expect(summarizeCall('Bash', { command: 'x'.repeat(500) }).length).toBe(300)
  })
})

describe('reading the end of a transcript', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('only whole lines, from partway into a long file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-peek-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(file, ['a'.repeat(100), 'second', 'third', ''].join('\n'))
    expect(await tailLines(file, 20)).toEqual(['second', 'third'])
    expect(await tailLines(file)).toEqual(['a'.repeat(100), 'second', 'third'])
  })
})

describe('a peek, read in main', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const docWith = (transcriptPath: string | null): CanvasDoc =>
    ({ nodes: [{ id: 'a', kind: 'claude', title: 'A', transcriptPath }, { id: 't', kind: 'terminal', title: 'T' }] }) as unknown as CanvasDoc

  test('the last thing it said, what it is waiting on, and since when', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-peek-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(file, [prompt('fix it'), says('First.'), says('I need to run the migration.'), calls('1', 'Bash', { command: 'npm run migrate' }), ''].join('\n'))
    const r = await peekSession({ doc: () => docWith(file), since: () => ({ at: 7, exact: true }) }, 'a')
    expect(r).toEqual({ ok: true, peek: { since: { at: 7, exact: true }, lastMessage: 'I need to run the migration.', pending: { tool: 'Bash', summary: 'npm run migrate' }, problem: null } })
  })

  test('a long message keeps its end, where the question usually is', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pb-peek-'))
    const file = join(dir, 't.jsonl')
    writeFileSync(file, says('x'.repeat(10_000) + ' Shall I go on?') + '\n')
    const r = await peekSession({ doc: () => docWith(file), since: () => undefined }, 'a')
    if (!r.ok) throw new Error(r.reason)
    expect(r.peek.lastMessage!.length).toBe(MESSAGE_MAX)
    expect(r.peek.lastMessage!.startsWith('…')).toBe(true)
    expect(r.peek.lastMessage!.endsWith('Shall I go on?')).toBe(true)
  })

  test('no transcript yet, or one gone, is an empty conversation; only agents can be peeked at', async () => {
    expect(await peekSession({ doc: () => docWith(null), since: () => undefined }, 'a')).toEqual({ ok: true, peek: { since: null, lastMessage: null, pending: null, problem: null } })
    const gone = await peekSession({ doc: () => docWith(join(tmpdir(), 'pb-peek-missing.jsonl')), since: () => undefined }, 'a')
    expect(gone.ok && gone.peek.problem).toBeNull()
    expect((await peekSession({ doc: () => docWith(null), since: () => undefined }, 't')).ok).toBe(false)
    expect((await peekSession({ doc: () => docWith(null), since: () => undefined }, 'nope')).ok).toBe(false)
  })
})

describe('when a status started', () => {
  test('an observed change is exact; one found on starting up is not; no change keeps the time', () => {
    let now = 100
    const tracker = createStatusTracker({ notify: () => {}, now: () => now })
    expect(tracker.since('a')).toBeUndefined()
    tracker.seed('a', 'needs-you')
    expect(tracker.since('a')).toEqual({ at: 100, exact: false })
    now = 200
    tracker.apply('a', { type: 'hook', name: 'Notification', notificationType: 'permission_prompt' })
    expect(tracker.since('a')).toEqual({ at: 100, exact: false })
    tracker.apply('a', { type: 'hook', name: 'PostToolUse' })
    expect(tracker.since('a')).toEqual({ at: 200, exact: true })
    now = 300
    tracker.apply('a', { type: 'hook', name: 'PermissionRequest' })
    expect(tracker.get('a')).toBe('needs-you')
    expect(tracker.since('a')).toEqual({ at: 300, exact: true })
  })
})
