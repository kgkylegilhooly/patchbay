import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { claudeOutput, DENIED, journalLine, pickHookFields } from '../../src/main/sessions/hookPayload'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const dir = mkdtempSync(join(tmpdir(), 'patchbay payload '))
afterAll(() => removeTemp(dir))

const SUGGESTION = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }

const EVENTS: Array<[string, Record<string, unknown>]> = [
  ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: 't', cwd: 'c', prompt: 'secret words', permission_mode: 'default' }],
  ['PostToolUse', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { a: 1 }, tool_response: 'big' }],
  ['StopFailure', { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'x'.repeat(3000), error_details: 'd' }],
  ['Notification', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' }],
  ['SubagentStop', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: 'p', turn_id: 't' }],
  ['PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [SUGGESTION] }],
  ['SessionEnd', { reason: 'exit' }]
]

/** What hook.cjs journals for this event when no app is there. */
function journalledByHookCjs(name: string, payload: Record<string, unknown>, nodeId: string): Record<string, unknown> {
  const control = join(dir, nodeId)
  spawnSync(process.execPath, [resolve('resources/hook.cjs'), name], {
    input: JSON.stringify(payload),
    env: { ...process.env, PATCHBAY_ENDPOINT_FILE: join(control, 'endpoint.json'), PATCHBAY_NODE_ID: nodeId, PATCHBAY_TOKEN: 't' },
    windowsHide: true
  })
  const { at: _at, ...rest } = JSON.parse(readFileSync(join(control, 'missed', `${nodeId}.jsonl`), 'utf8').trim())
  return rest
}

test('the host journals each event exactly as hook.cjs does', () => {
  EVENTS.forEach(([name, payload], i) => {
    const { at, ...ours } = JSON.parse(journalLine(pickHookFields(payload, name), 123))
    expect(at).toBe(123)
    expect(ours).toEqual(journalledByHookCjs(name, payload, `n${i}`))
  })
})

test('picks only what Patchbay uses, and keeps a permission request its tool unless the input is huge', () => {
  // The prompt goes to the app, so a send can be confirmed by it, but never into the journal on disk.
  expect(pickHookFields(EVENTS[0][1], 'UserPromptSubmit')).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: 't', cwd: 'c', prompt: 'secret words' })
  expect(journalLine(pickHookFields(EVENTS[0][1], 'UserPromptSubmit'), 1)).not.toContain('secret words')
  expect(pickHookFields({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(65 * 1024) }, 'UserPromptSubmit')).toEqual({ hook_event_name: 'UserPromptSubmit' })
  expect(pickHookFields({}, 'Stop')).toEqual({ hook_event_name: 'Stop' })
  expect(pickHookFields(EVENTS[5][1], 'PermissionRequest')).toEqual({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [SUGGESTION] })
  const huge = pickHookFields({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { content: 'x'.repeat(300 * 1024) } }, 'PermissionRequest')
  expect(huge).toEqual({ hook_event_name: 'PermissionRequest', tool_name: 'Write' })
})

test("the app's answer becomes Claude's hook output, as hook.cjs prints it", () => {
  expect(claudeOutput('PermissionRequest', { decision: 'allow' })).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  expect(claudeOutput('PermissionRequest', { decision: 'deny' })).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENIED } } })
  expect(claudeOutput('PermissionRequest', { decision: null })).toEqual({})
  expect(claudeOutput('PermissionRequest', undefined)).toEqual({})
  expect(claudeOutput('SessionStart', { context: 'c'.repeat(5000) })).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'c'.repeat(4000) } })
  expect(claudeOutput('Stop', { decision: 'allow', context: 'x' })).toEqual({})
})

test("Claude's suggested rules go to the app when small, and never into the journal", () => {
  const big = { ...EVENTS[5][1], permission_suggestions: [{ ...SUGGESTION, rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(20 * 1024) }] }] }
  expect(pickHookFields(big, 'PermissionRequest')).not.toHaveProperty('permission_suggestions')
  expect(journalLine(pickHookFields(EVENTS[5][1], 'PermissionRequest'), 1)).not.toContain('permission_suggestions')
})

test('Always allow echoes the rule back with the allow, and never with a deny', () => {
  const updatedPermissions = [SUGGESTION]
  expect(claudeOutput('PermissionRequest', { decision: 'allow', updatedPermissions })).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions } }
  })
  expect(claudeOutput('PermissionRequest', { decision: 'deny', updatedPermissions })).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENIED } }
  })
})

test("any event from inside a subagent keeps its agent_id, so it's never taken for the window's own conversation", () => {
  expect(pickHookFields({ hook_event_name: 'PostToolUse', session_id: 's', agent_id: 'a2' }, 'PostToolUse')).toEqual({ hook_event_name: 'PostToolUse', session_id: 's', agent_id: 'a2' })
})
