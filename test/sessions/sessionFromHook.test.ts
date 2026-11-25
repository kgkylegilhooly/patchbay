import { expect, test } from 'vitest'
import { sessionFromHook } from '../../src/main/sessions/sessionFromHook'

// Which conversation a window is in, from hooks other than a lost SessionStart. Each rule of the module's comment, in turn.
const known = (sessionId: string | null, transcriptPath: string | null = null, agent?: string) => ({ sessionId, transcriptPath, ...(agent ? { agent } : {}) })
const hook = (name: string, sessionId: string, transcriptPath?: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: sessionId, ...(transcriptPath ? { transcript_path: transcriptPath } : {}), ...extra })

test('a window with no session yet learns it from any ordinary hook', () => {
  expect(sessionFromHook(known(null), hook('PostToolUse', 's1', 'C:\\t1.jsonl'))).toEqual({ sessionId: 's1', transcriptPath: 'C:\\t1.jsonl' })
  expect(sessionFromHook(known(null), hook('Notification', 's1'))).toEqual({ sessionId: 's1', transcriptPath: null })
})

test('never from SessionStart, SessionEnd, a subagent starting or stopping, or anything inside a subagent', () => {
  for (const name of ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop']) expect(sessionFromHook(known(null), hook(name, 's1', 'C:\\t.jsonl'))).toBeNull()
  expect(sessionFromHook(known(null), hook('PostToolUse', 'sub', 'C:\\sub.jsonl', { agent_id: 'a1' }))).toBeNull()
})

test('only a main-conversation turn moves a window to another session; a tool call or notification does not', () => {
  for (const name of ['UserPromptSubmit', 'Stop', 'StopFailure']) {
    expect(sessionFromHook(known('old', 'C:\\old.jsonl'), hook(name, 'new', 'C:\\new.jsonl'))).toEqual({ sessionId: 'new', transcriptPath: 'C:\\new.jsonl' })
  }
  expect(sessionFromHook(known('old', 'C:\\old.jsonl'), hook('PostToolUse', 'new', 'C:\\new.jsonl'))).toBeNull()
})

test('the same session fills in a missing transcript from anything, but changes a known one only on a turn', () => {
  expect(sessionFromHook(known('s1', null), hook('PreToolUse', 's1', 'C:\\t1.jsonl'))).toEqual({ sessionId: 's1', transcriptPath: 'C:\\t1.jsonl' })
  expect(sessionFromHook(known('s1', 'C:\\t1.jsonl'), hook('PreToolUse', 's1', 'C:\\other.jsonl'))).toBeNull()
  expect(sessionFromHook(known('s1', 'C:\\t1.jsonl'), hook('Stop', 's1', 'C:\\moved.jsonl'))).toEqual({ sessionId: 's1', transcriptPath: 'C:\\moved.jsonl' })
  expect(sessionFromHook(known('s1', 'C:\\t1.jsonl'), hook('Stop', 's1', 'C:\\t1.jsonl'))).toBeNull()
  expect(sessionFromHook(known('s1', 'C:\\t1.jsonl'), hook('Stop', 's1'))).toBeNull()
})

test('a Codex window is left alone, and a hook with no session or no name changes nothing', () => {
  expect(sessionFromHook(known(null, null, 'codex'), hook('Stop', 'child', 'C:\\c.jsonl'))).toBeNull()
  expect(sessionFromHook(known(null), { hook_event_name: 'Stop' })).toBeNull()
  expect(sessionFromHook(known(null), { session_id: 's1' })).toBeNull()
  expect(sessionFromHook(known(null), hook('Stop', ''))).toBeNull()
})
