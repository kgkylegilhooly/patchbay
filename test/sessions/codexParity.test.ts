import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { claudeErrorFor, codexStopFailure, emptyCodexTurn, foldCodexLine } from '../../src/core/status/codexRollout'
import { nextStatus } from '../../src/core/status/machine'
import { foldCodexChild } from '../../src/core/subagents/codexChild'
import { emptyProgress } from '../../src/core/subagents/parse'
import { createAgentStops } from '../../src/main/sessions/agentStops'
import { CODEX_HOOK_EVENTS, codexHookArgs } from '../../src/main/sessions/codexLaunch'
import { createCodexStops } from '../../src/main/sessions/codexStops'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { allowedChildRollout, createCodexCards } from '../../src/main/subagents/codexCards'
import { parseResetTime, stopFromHook, stopLabel } from '../../src/shared/agentStop'

/*
 * Fixtures. Codex has no quota left on this PC, so no failed turn could be recorded. The lines are written in the
 * shape of real Codex 0.170 rollout lines (timestamp, type, payload), with event names and fields from its protocol
 * as read from the 0.170 binary. TOKEN_COUNT is copied from a real local rollout, with used_percent raised to 100.
 */
const T0 = Date.parse('2026-11-20T14:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
const ev = (s: number, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: at(s), type: 'event_msg', payload })
const RESET = Math.floor((T0 + 3 * 3600_000) / 1000)
const TOKEN_COUNT = (s: number, used = 100): string =>
  JSON.stringify({
    timestamp: at(s),
    ordinal: 21,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 18593, cached_input_tokens: 7168, output_tokens: 126, total_tokens: 18719 }, last_token_usage: { input_tokens: 18593, output_tokens: 126, total_tokens: 18719 }, model_context_window: 258400 },
      rate_limits: { limit_id: 'codex', limit_name: null, primary: { used_percent: used, window_minutes: 300, resets_at: RESET }, secondary: { used_percent: 12.0, window_minutes: 10080, resets_at: RESET + 5 * 86400 }, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'plus', rate_limit_reached_type: used >= 100 ? 'rate_limit_reached' : null }
    }
  })
const STARTED = (s: number): string => ev(s, { type: 'task_started', turn_id: 'turn-1' })
const COMPLETE = (s: number): string => ev(s, { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null })
const USAGE_ERROR = (s: number): string => ev(s, { type: 'error', message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:00 PM.", codex_error_info: 'usage_limit_exceeded' })

const fold = (...lines: string[]) => lines.reduce(foldCodexLine, emptyCodexTurn())

describe('reading a Codex rollout', () => {
  test("a usage limit becomes Claude's usage-limit stop, with the exact reset from Codex's own limits", () => {
    const state = fold(STARTED(0), TOKEN_COUNT(5), USAGE_ERROR(6), COMPLETE(6))
    expect(state).toMatchObject({ ended: true, failure: { error: 'rate_limit', codexError: 'usage_limit_exceeded' } })
    const payload = codexStopFailure(state)!
    const stop = stopFromHook(payload, T0 + 6000, state.plan)
    expect(stop).toMatchObject({ kind: 'usage-limit', until: RESET * 1000, holds: 'reset' })
    expect(stopLabel(stop, T0 + 7000)).toMatch(/^Usage limit until /)
  })

  test('without a full window, the reset comes from the message: "try again at 5:00 PM"', () => {
    const state = fold(STARTED(0), TOKEN_COUNT(5, 40), USAGE_ERROR(6))
    const stop = stopFromHook(codexStopFailure(state)!, T0 + 6000, state.plan)
    const d = new Date(stop.until!)
    expect([stop.kind, d.getHours(), d.getMinutes()]).toEqual(['usage-limit', 17, 0])
  })

  test("Codex's other failures map onto the same stop kinds", () => {
    const kind = (info: unknown, message = 'failed') => stopFromHook(codexStopFailure(fold(STARTED(0), ev(1, { type: 'error', message, codex_error_info: info })))!, T0).kind
    expect(kind('server_overloaded')).toBe('server')
    expect(kind({ http_connection_failed: { http_status_code: 502 } })).toBe('server')
    expect(kind('unauthorized')).toBe('auth')
    expect(kind('quota_exceeded')).toBe('billing')
    expect(kind('rate_limit_exceeded')).toBe('rate-limit')
    expect(kind('context_window_exceeded')).toBe('error')
    expect(kind(null, "You've hit your usage limit.")).toBe('usage-limit')
    expect(claudeErrorFor('usage_limit_exceeded', 'no words')).toBe('rate_limit')
    // A usage limit whose message doesn't say so still reads as one.
    expect(kind('usage_limit_exceeded', 'Try again later.')).toBe('usage-limit')
  })

  test('a new turn clears the last one\'s failure; an Esc abort is recorded', () => {
    expect(fold(STARTED(0), USAGE_ERROR(1), COMPLETE(1), STARTED(10)).failure).toBeNull()
    expect(fold(STARTED(0), ev(3, { type: 'turn_aborted', reason: 'interrupted' })).aborted).toMatchObject({ reason: 'interrupted' })
    // Not events, or not JSON: nothing changes.
    expect(fold('{"type":"response_item","payload":{"type":"message"}}', 'not json', STARTED(0))).toMatchObject({ inTurn: true })
  })

  test("Codex's 'try again at Nov 21st, 2026 3:45 PM' names that day, and the year is taken as given", () => {
    const after = new Date(2026, 10, 20, 12, 0).getTime()
    expect(parseResetTime('or try again at Nov 21st, 2026 3:45 PM.', after)).toBe(new Date(2026, 10, 21, 15, 45).getTime())
    expect(parseResetTime('Try again at 3:45 PM.', after)).toBe(new Date(2026, 10, 20, 15, 45).getTime())
    // Claude's own wording is read as before.
    expect(parseResetTime("You've hit your 5-hour limit · resets 12:30am", after)).toBe(new Date(2026, 10, 21, 0, 30).getTime())
  })
})

describe('hooks', () => {
  test('Codex registers Interrupt and its subagent hooks; Interrupt means it is at its prompt', () => {
    expect(CODEX_HOOK_EVENTS).toEqual(expect.arrayContaining(['Interrupt', 'SubagentStart', 'SubagentStop']))
    expect(CODEX_HOOK_EVENTS).not.toContain('SessionEnd')
    expect(codexHookArgs('C:/pb/hook.cjs').join(' ')).toContain('hooks.Interrupt=[{hooks=[{type="command",command="node \\"C:/pb/hook.cjs\\" Interrupt"}]}]')
    expect(nextStatus('unknown', { type: 'hook', name: 'Interrupt' })).toBe('idle')
    expect(nextStatus('working', { type: 'hook', name: 'Interrupt' })).toBe('idle')
    // A subagent starting or stopping says nothing about the window's own state.
    expect(nextStatus('needs-you', { type: 'hook', name: 'SubagentStart' })).toBe('needs-you')
    expect(nextStatus('working', { type: 'hook', name: 'SubagentStop' })).toBe('working')
  })
})

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pb-codex-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A Codex node with a rollout, its status tracker and stops, wired as src/main/sessions/codexStopsSetup.ts does. */
function codexWorld(lines: string[] = []) {
  const rollout = join(temp(), 'rollout-2026-11-20T14-00-00-01a1f6aa-0000-7000-8000-000000000001.jsonl')
  writeFileSync(rollout, lines.map((l) => `${l}\n`).join(''))
  let clock = T0 + 60_000
  const tracker = createStatusTracker({ notify: () => {}, now: () => clock })
  const stops = createAgentStops({ tracker, now: () => clock })
  const hook = (payload: Record<string, unknown>, limits?: Parameters<typeof stops.noteHook>[2]): void => {
    tracker.apply('c', { type: 'hook', name: String(payload.hook_event_name) })
    stops.noteHook('c', payload, limits)
  }
  const watcher = createCodexStops({
    nodes: () => [{ id: 'c', transcriptPath: rollout }],
    status: (id) => tracker.get(id),
    apply: async (_id, payload, limits) => hook(payload, limits),
    now: () => clock,
    everyMs: 0
  })
  return { rollout, tracker, stops, watcher, hook, write: (...l: string[]) => appendFileSync(rollout, l.map((x) => `${x}\n`).join('')), advance: (ms: number) => void (clock += ms) }
}

describe('Codex nodes get the stop records and statuses Claude nodes get', () => {
  test("a Stop hook ending a failed turn is taken as Claude's StopFailure: unknown, with the limit and its reset", async () => {
    const w = codexWorld()
    w.hook({ hook_event_name: 'UserPromptSubmit' })
    await w.watcher.tick()
    w.write(STARTED(0), TOKEN_COUNT(5), USAGE_ERROR(6))
    const { payload, limits } = await w.watcher.translate('c', { hook_event_name: 'Stop' })
    expect(payload).toMatchObject({ hook_event_name: 'StopFailure', error: 'rate_limit', codex_error: 'usage_limit_exceeded' })
    w.hook(payload, limits)
    expect(w.tracker.get('c')).toBe('unknown')
    expect(w.stops.get('c')).toMatchObject({ kind: 'usage-limit', until: RESET * 1000, holds: 'reset' })
    expect(w.stops.holding('c')).toBe(true)
    // A later look doesn't apply it twice.
    w.write(COMPLETE(7))
    await w.watcher.tick()
    expect(w.stops.get('c')?.at).toBe(T0 + 6000)
  })

  test('a Stop hook after a turn that went well is left as it is', async () => {
    const w = codexWorld()
    w.hook({ hook_event_name: 'UserPromptSubmit' })
    await w.watcher.tick()
    w.write(STARTED(0), TOKEN_COUNT(5, 30), COMPLETE(9))
    expect((await w.watcher.translate('c', { hook_event_name: 'Stop' })).payload).toEqual({ hook_event_name: 'Stop' })
  })

  test('with no Stop hook, the turn ending on its error is enough', async () => {
    const w = codexWorld()
    w.hook({ hook_event_name: 'UserPromptSubmit' })
    await w.watcher.tick()
    w.write(STARTED(0), ev(2, { type: 'error', message: 'stream disconnected', codex_error_info: 'response_stream_disconnected' }), COMPLETE(2))
    await w.watcher.tick()
    expect(w.tracker.get('c')).toBe('unknown')
    expect(w.stops.get('c')).toMatchObject({ kind: 'server', holds: null })
  })

  test("with neither, the error followed by 30 s of nothing is taken as the turn's end", async () => {
    const w = codexWorld()
    w.hook({ hook_event_name: 'UserPromptSubmit' })
    await w.watcher.tick()
    w.write(STARTED(0), ev(2, { type: 'error', message: 'Your access token could not be refreshed', codex_error_info: 'unauthorized' }))
    await w.watcher.tick()
    expect(w.tracker.get('c')).toBe('working')
    w.advance(31_000)
    await w.watcher.tick()
    expect(w.stops.get('c')).toMatchObject({ kind: 'auth', holds: 'person' })
  })

  test('a failure already in the rollout when Patchbay first looks, between turns, is not applied again', async () => {
    const w = codexWorld([STARTED(0), USAGE_ERROR(1), COMPLETE(1)])
    w.hook({ hook_event_name: 'Stop' })
    await w.watcher.tick()
    expect(w.tracker.get('c')).toBe('idle')
    expect(w.stops.get('c')).toBeUndefined()
  })

  test('Esc in a session launched without the Interrupt hook: the aborted turn brings it back to idle', async () => {
    const w = codexWorld()
    w.hook({ hook_event_name: 'UserPromptSubmit' })
    await w.watcher.tick()
    w.tracker.apply('c', { type: 'interrupt-key' })
    expect(w.tracker.get('c')).toBe('unknown')
    w.write(STARTED(0), ev(3, { type: 'turn_aborted', reason: 'interrupted' }))
    await w.watcher.tick()
    expect(w.tracker.get('c')).toBe('idle')
    expect(w.stops.get('c')).toBeUndefined()
  })
})

describe('Codex subagent cards', () => {
  const child = (dir: string, id: string, lines: string[]): string => {
    const path = join(dir, `rollout-2026-11-20T14-00-05-${id}.jsonl`)
    writeFileSync(path, lines.map((l) => `${l}\n`).join(''))
    return path
  }
  const item = (s: number, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: at(s), type: 'response_item', payload })
  const CHILD = [
    JSON.stringify({ timestamp: at(5), type: 'session_meta', payload: { id: 'x' } }),
    item(5, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
    item(5, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Find every caller of slugify\nand list them' }] }),
    item(6, { type: 'function_call', name: 'shell', arguments: '{}' }),
    item(7, { type: 'custom_tool_call', name: 'apply_patch', input: '' }),
    TOKEN_COUNT(8, 10)
  ]

  test('SubagentStart shows a running card; SubagentStop ends it, with its rollout read for tools, tokens and prompt', async () => {
    const dir = temp()
    let clock = T0
    const cards = createCodexCards({ now: () => clock })
    const parent = join(dir, 'rollout-parent.jsonl')
    cards.noteHook('c', { hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'explorer', turn_id: 't' }, parent)
    await cards.refresh([{ nodeId: 'c', transcriptPath: parent, busy: true, exited: false }])
    expect(cards.snapshot().c.cards[0]).toMatchObject({ id: 'agent-1', agentType: 'explorer', description: 'explorer', status: 'running', tools: 0 })

    const path = child(dir, 'agent-1', CHILD)
    clock += 4000
    cards.noteHook('c', { hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'explorer', agent_transcript_path: path }, parent)
    await cards.refresh([{ nodeId: 'c', transcriptPath: parent, busy: true, exited: false }])
    expect(cards.snapshot().c).toMatchObject({ ran: 1, cards: [{ status: 'done', tools: 2, tokens: 18719, description: 'Find every caller of slugify', endedAt: T0 + 4000 }] })
    expect(cards.transcriptOf('c', 'agent-1')).toBe(path)
  })

  test('a running card finds its rollout beside the parent by its id (UNVERIFIED naming), and fails with its error', async () => {
    const dir = temp()
    const cards = createCodexCards({ now: () => T0 })
    const parent = join(dir, 'rollout-parent.jsonl')
    child(dir, 'agent-2', [...CHILD, ev(9, { type: 'error', message: 'Rate limit reached' })])
    cards.noteHook('c', { hook_event_name: 'SubagentStart', agent_id: 'agent-2', agent_type: 'worker' }, parent)
    await cards.refresh([{ nodeId: 'c', transcriptPath: parent, busy: true, exited: false }])
    expect(cards.snapshot().c.cards[0]).toMatchObject({ status: 'running', tools: 2 })
    cards.noteHook('c', { hook_event_name: 'SubagentStop', agent_id: 'agent-2' }, parent)
    await cards.refresh([{ nodeId: 'c', transcriptPath: parent, busy: true, exited: false }])
    expect(cards.snapshot().c.cards[0]).toMatchObject({ status: 'failed', failure: 'Rate limit reached' })
  })

  test("a window that exits fails its running cards; a new turn drops the last turn's finished ones", async () => {
    const cards = createCodexCards({ now: () => T0 })
    cards.noteHook('c', { hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'worker' }, null)
    cards.noteHook('c', { hook_event_name: 'SubagentStart', agent_id: 'b', agent_type: 'worker' }, null)
    cards.noteHook('c', { hook_event_name: 'SubagentStop', agent_id: 'b' }, null)
    cards.turnStarted('c')
    expect(cards.snapshot().c.cards.map((x) => x.id)).toEqual(['a'])
    await cards.refresh([{ nodeId: 'c', transcriptPath: null, busy: false, exited: true }])
    expect(cards.snapshot().c.cards[0]).toMatchObject({ status: 'failed', failure: 'The session ended' })
    // An id that can't be a file name, and other hooks, are ignored.
    cards.noteHook('c', { hook_event_name: 'SubagentStart', agent_id: '../x' }, null)
    cards.noteHook('c', { hook_event_name: 'Stop', agent_id: 'z' }, null)
    expect(cards.snapshot().c.ran).toBe(1)
  })

  test("a child's rollout folds into a card's progress", () => {
    expect(foldCodexChild(emptyProgress(), CHILD.join('\n'))).toMatchObject({ tools: 2, tokens: 18719, prompt: 'Find every caller of slugify', startedAt: T0 + 5000, lastAt: T0 + 8000 })
  })
})

describe('only a turn-ending error stops a Codex node (review M2, L2, L3)', () => {
  test('an error the turn went on from is no failure; nor is one between turns', () => {
    const went = fold(STARTED(0), ev(1, { type: 'error', message: 'apply failed', codex_error_info: 'other' }), ev(2, { type: 'agent_message', message: 'Trying again' }), COMPLETE(3))
    expect(went.failure).toBeNull()
    const answered = fold(STARTED(0), ev(1, { type: 'error', message: 'x', codex_error_info: 'other' }), JSON.stringify({ timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }), COMPLETE(3))
    expect(answered.failure).toBeNull()
    expect(fold(STARTED(0), COMPLETE(1), ev(5, { type: 'error', message: 'resume failed', codex_error_info: 'other' })).failure).toBeNull()
    // A limit update after the error doesn't undo it: the turn still ended on it.
    expect(fold(STARTED(0), USAGE_ERROR(1), TOKEN_COUNT(1), COMPLETE(1)).failure).not.toBeNull()
  })

  test('the Stop after a turn that recovered from an error stays a Stop, and an idle node is never stopped by a stray error', async () => {
    const w = codexWorld()
    w.hook({ hook_event_name: 'UserPromptSubmit' })
    await w.watcher.tick()
    w.write(STARTED(0), ev(1, { type: 'error', message: 'x', codex_error_info: 'other' }), ev(2, { type: 'agent_message', message: 'ok' }), COMPLETE(3))
    expect((await w.watcher.translate('c', { hook_event_name: 'Stop' })).payload).toEqual({ hook_event_name: 'Stop' })
    w.hook({ hook_event_name: 'Stop' })
    w.write(ev(10, { type: 'error', message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' }))
    await w.watcher.tick()
    expect(w.tracker.get('c')).toBe('idle')
    expect(w.stops.get('c')).toBeUndefined()
  })

  test("a child's Stop or Interrupt, from another session, is ignored for the window", async () => {
    const rollout = join(temp(), 'r.jsonl')
    writeFileSync(rollout, '')
    const watcher = createCodexStops({ nodes: () => [{ id: 'c', transcriptPath: rollout, sessionId: 'parent' }], status: () => 'working', apply: async () => {}, everyMs: 0 })
    expect(await watcher.translate('c', { hook_event_name: 'Interrupt', session_id: 'child' })).toMatchObject({ ignore: true })
    expect(await watcher.translate('c', { hook_event_name: 'Stop', session_id: 'child' })).toMatchObject({ ignore: true })
    expect((await watcher.translate('c', { hook_event_name: 'Interrupt', session_id: 'parent' })).ignore).toBeUndefined()
    expect((await watcher.translate('c', { hook_event_name: 'Stop' })).ignore).toBeUndefined()
  })

  test("a subagent rollout is read only from under the parent's Codex sessions folder", () => {
    const parent = 'C:/Users/me/.codex/sessions/2026/11/20/rollout-p.jsonl'
    expect(allowedChildRollout(parent, 'C:/Users/me/.codex/sessions/2026/11/21/rollout-c.jsonl')).toBe(true)
    expect(allowedChildRollout(parent, 'C:/Users/me/.ssh/id_rsa')).toBe(false)
    expect(allowedChildRollout(parent, 'C:/Users/me/.codex/auth.jsonl')).toBe(false)
    expect(allowedChildRollout(parent, 'C:/Users/me/.codex/sessions/2026/11/20/notes.txt')).toBe(false)
    expect(allowedChildRollout(null, 'C:/Users/me/.codex/sessions/x.jsonl')).toBe(false)
  })
})
