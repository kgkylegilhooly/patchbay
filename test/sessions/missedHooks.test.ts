import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { foldMissedHooks, takeMissedHooks } from '../../src/main/sessions/missedHooks'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pb-missed-'))
  dirs.push(d)
  return d
}

const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name, ...extra })

test('no events tell nothing, so the status stays unknown', () => {
  expect(foldMissedHooks([]).status).toBe('unknown')
})

test('the last event decides, and a finished turn is counted for anyone waiting on it', () => {
  const summary = foldMissedHooks([ev('PreToolUse'), ev('PostToolUse'), ev('Stop')])
  expect(summary.status).toBe('idle')
  expect(summary.turns).toBe(1)
})

test('work carrying on after a finished turn reads as working', () => {
  const summary = foldMissedHooks([ev('Stop'), ev('UserPromptSubmit'), ev('PreToolUse')])
  expect(summary.status).toBe('working')
  expect(summary.turns).toBe(1)
})

test('a permission request while the app was closed reads as needing you', () => {
  expect(foldMissedHooks([ev('PreToolUse'), ev('PermissionRequest')]).status).toBe('needs-you')
})

test('events that say nothing about the status can never invent an idle', () => {
  expect(foldMissedHooks([ev('SessionStart', { source: 'resume' }), ev('Notification', { notification_type: 'idle_prompt' })]).status).toBe('unknown')
  expect(foldMissedHooks([ev('StopFailure')]).status).toBe('unknown')
})

test('the latest session id is kept, so /clear while away keeps resume pointing at the right conversation', () => {
  const summary = foldMissedHooks([
    ev('SessionStart', { session_id: 'one', transcript_path: 'a.jsonl', source: 'resume' }),
    ev('SessionEnd', { reason: 'clear' }),
    ev('SessionStart', { session_id: 'two', transcript_path: 'b.jsonl', source: 'clear' })
  ])
  expect(summary.sessionId).toBe('two')
  expect(summary.transcriptPath).toBe('b.jsonl')
  expect(summary.hasConversation).toBe(false)
})

test('a submitted prompt means there is a conversation, and the starting prompt has done its job', () => {
  const summary = foldMissedHooks([ev('UserPromptSubmit')])
  expect(summary.hasConversation).toBe(true)
  expect(summary.promptSubmitted).toBe(true)
})

test('events with no name are skipped', () => {
  expect(foldMissedHooks([{}, { hook_event_name: 5 }]).status).toBe('unknown')
})

test('taking reads the older part first, then clears both', () => {
  const d = dir()
  const file = join(d, `${encodeURIComponent('node/1')}.jsonl`)
  writeFileSync(`${file}.old`, `${JSON.stringify(ev('PreToolUse'))}\n`)
  writeFileSync(file, `${JSON.stringify(ev('Stop'))}\n`)
  expect(takeMissedHooks(d, 'node/1').map((e) => e.hook_event_name)).toEqual(['PreToolUse', 'Stop'])
  expect(takeMissedHooks(d, 'node/1')).toEqual([])
})

test('a partial last line from a killed hook is skipped, and the rest still count', () => {
  const d = dir()
  writeFileSync(join(d, 'n.jsonl'), `${JSON.stringify(ev('Stop'))}\n{"hook_event_na`)
  expect(takeMissedHooks(d, 'n').map((e) => e.hook_event_name)).toEqual(['Stop'])
})

test('no journal is simply no events', () => {
  expect(takeMissedHooks(dir(), 'nobody')).toEqual([])
})

test('with the SessionStart lost, a turn in the journal still tells the session and its transcript', () => {
  const summary = foldMissedHooks([ev('UserPromptSubmit', { session_id: 'sid', transcript_path: 'sid.jsonl' }), ev('Stop', { session_id: 'sid', transcript_path: 'sid.jsonl' })])
  expect(summary).toMatchObject({ sessionId: 'sid', transcriptPath: 'sid.jsonl' })
})

test("a tool call's or subagent's session in the journal is never taken for the window's", () => {
  const summary = foldMissedHooks([
    ev('SessionStart', { session_id: 'main', transcript_path: 'main.jsonl' }),
    ev('PostToolUse', { session_id: 'sub', transcript_path: 'sub.jsonl' }),
    ev('SubagentStop', { session_id: 'sub', transcript_path: 'sub.jsonl' }),
    ev('SessionEnd', { session_id: 'sub', reason: 'other' })
  ])
  expect(summary).toMatchObject({ sessionId: 'main', transcriptPath: 'main.jsonl' })
})
