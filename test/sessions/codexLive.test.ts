import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { codexStopFailure, emptyCodexTurn, foldCodexLine } from '../../src/core/status/codexRollout'
import { foldCodexChild } from '../../src/core/subagents/codexChild'
import { emptyProgress } from '../../src/core/subagents/parse'
import { parseLine, readMessages } from '../../src/core/transcript/read'
import { createAgentStops } from '../../src/main/sessions/agentStops'
import { createCodexStops } from '../../src/main/sessions/codexStops'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createCodexCards } from '../../src/main/subagents/codexCards'
import { stopFromHook } from '../../src/shared/agentStop'

/*
 * Real Codex 0.170 output, recorded by test/acceptance/codex-states-real.cjs on 2026-11-21 (gpt-6-luna, low
 * reasoning), trimmed and redacted. See docs/plans/codex-live.md for what each shows.
 */
const FIXTURES = join(__dirname, '..', 'fixtures', 'codex-0.170')
const lines = (name: string): string[] => readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean)
const hooks = JSON.parse(readFileSync(join(FIXTURES, 'hooks.json'), 'utf8')) as Record<string, Record<string, unknown>>
const fold = (ls: string[]) => ls.reduce(foldCodexLine, emptyCodexTurn())

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pb-codex-live-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The failed turn's task_complete with another error in its place, as a usage limit would end the same turn. */
function withError(error: { message: string; codex_error_info: unknown }): string[] {
  return lines('failed-turn.jsonl').map((l) => {
    const j = JSON.parse(l)
    if (j.payload?.type === 'task_complete') j.payload.error = error
    return JSON.stringify(j)
  })
}
/** A real token_count line from the live session, with its 5-hour window full. */
function fullWindow(): { line: string; resetsAt: number } {
  const real = lines('live-session.jsonl').find((l) => l.includes('"token_count"'))!
  const j = JSON.parse(real)
  j.payload.rate_limits.primary.used_percent = 100
  j.payload.rate_limits.rate_limit_reached_type = 'rate_limit_reached'
  return { line: JSON.stringify(j), resetsAt: j.payload.rate_limits.primary.resets_at }
}

describe('a failed Codex turn, as 0.170 really writes it', () => {
  test('the error is on task_complete (no error event), and the turn has ended on it', () => {
    const state = fold(lines('failed-turn.jsonl'))
    expect(state).toMatchObject({ ended: true, inTurn: false, failure: { codexError: 'model_not_found', message: expect.stringContaining('pb-no-such-model') } })
    expect(codexStopFailure(state)).toMatchObject({ hook_event_name: 'StopFailure', codex_error: 'model_not_found' })
  })

  test('no Stop hook comes: the rollout alone takes the node from working to unknown, with a stop record', async () => {
    const rollout = join(temp(), 'rollout.jsonl')
    writeFileSync(rollout, '')
    let clock = Date.parse('2026-11-21T03:02:40Z')
    const tracker = createStatusTracker({ notify: () => {}, now: () => clock })
    const stops = createAgentStops({ tracker, now: () => clock })
    const watcher = createCodexStops({
      nodes: () => [{ id: 'c', transcriptPath: rollout, sessionId: hooks.SessionStart.session_id as string }],
      status: (id) => tracker.get(id),
      apply: async (id, payload, limits) => {
        tracker.apply(id, { type: 'hook', name: String(payload.hook_event_name) })
        stops.noteHook(id, payload, limits)
      },
      now: () => clock,
      everyMs: 0
    })
    tracker.apply('c', { type: 'hook', name: 'UserPromptSubmit' })
    await watcher.tick()
    writeFileSync(rollout, lines('failed-turn.jsonl').map((l) => `${l}\n`).join(''))
    clock += 2000
    await watcher.tick()
    expect(tracker.get('c')).toBe('unknown')
    expect(stops.get('c')).toMatchObject({ kind: 'error', message: expect.stringContaining('not supported') })
  })

  test('a usage limit in that shape holds until the full window resets', () => {
    const { line, resetsAt } = fullWindow()
    const failed = withError({ message: "You've hit your usage limit. Upgrade to Pro or try again at 5:00 PM.", codex_error_info: 'usage_limit_exceeded' })
    // The limits line comes before the turn's end, as in the real session.
    const state = fold([...failed.slice(0, -2), line, ...failed.slice(-2)])
    const payload = codexStopFailure(state)!
    expect(payload).toMatchObject({ error: 'rate_limit', codex_error: 'usage_limit_exceeded' })
    expect(stopFromHook(payload, Date.now(), state.plan)).toMatchObject({ kind: 'usage-limit', until: resetsAt * 1000, holds: 'reset' })
  })

  test('a turn that completes without an error is no failure', () => {
    const live = fold(lines('live-session.jsonl'))
    expect(live).toMatchObject({ ended: true, failure: null })
    expect(fold(withError(null as never)).failure).toBeNull()
  })
})

describe('Esc, as 0.170 really writes it', () => {
  test('turn_aborted "interrupted" closes the turn; the Interrupt hook names that turn', () => {
    const ls = lines('live-session.jsonl')
    const aborted = ls.findIndex((l) => l.includes('"turn_aborted"'))
    expect(fold(ls.slice(0, aborted + 1)).aborted).toMatchObject({ reason: 'interrupted' })
    expect(JSON.parse(ls[aborted]).payload.turn_id).toBe(hooks.Interrupt.turn_id)
    expect(Object.keys(hooks.Interrupt).sort()).toEqual(['cwd', 'hook_event_name', 'model', 'permission_mode', 'session_id', 'transcript_path', 'turn_id'])
  })
})

describe("a Codex rollout's conversation", () => {
  test('is read from item_completed UserMessage / AgentMessage, without the context Codex adds', () => {
    const rollout = join(temp(), 'r.jsonl')
    copyFileSync(join(FIXTURES, 'live-session.jsonl'), rollout)
    const messages = readMessages(rollout)
    expect(messages.slice(0, 4)).toEqual([
      { role: 'user', text: 'Reply with just the word ready.' },
      { role: 'assistant', text: 'ready' },
      { role: 'user', text: expect.stringContaining('Call the patchbay tool') },
      { role: 'assistant', text: 'done' }
    ])
    expect(messages.some((m) => /environment_context|You are Codex/.test(m.text))).toBe(false)
    // Each said once.
    expect(messages.filter((m) => m.text === 'ready')).toHaveLength(1)
  })

  test("Codex's older user_message / agent_message events are still read", () => {
    expect(parseLine(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }))).toEqual({ role: 'assistant', text: 'hi' })
  })
})

describe('a real Codex subagent', () => {
  test("its rollout starts with the parent's history; the card counts only the child's own part", () => {
    const progress = foldCodexChild(emptyProgress(), lines('subagent-child.jsonl').join('\n'))
    // The child called no tools (the spawn_agent call is the parent's, inherited), answered "pong", and its task is
    // named "pong": the task text itself is encrypted.
    expect(progress).toMatchObject({ tools: 0, prompt: 'pong', tokens: 21487 })
    expect(progress.error).toBeUndefined()
  })

  test('SubagentStart names the child by its rollout id; the card runs, then ends done with the real payloads', async () => {
    const dir = temp()
    const parent = join(dir, 'rollout-2026-11-21T03-11-01-01a1fc15-f99d-7941-8f4a-2f7b4b18a25f.jsonl')
    const childPath = join(dir, 'rollout-2026-11-21T03-11-03-01a1fc16-046b-7630-8620-b270e2ca2c85.jsonl')
    copyFileSync(join(FIXTURES, 'subagent-parent.jsonl'), parent)
    copyFileSync(join(FIXTURES, 'subagent-child.jsonl'), childPath)
    const start = hooks.SubagentStart
    expect(start).not.toHaveProperty('agent_transcript_path')
    expect(childPath).toContain(start.agent_id as string)
    const cards = createCodexCards({ now: () => Date.parse('2026-11-21T03:11:05Z') })
    cards.noteHook('c', start, parent)
    await cards.refresh([{ nodeId: 'c', transcriptPath: parent, busy: true, exited: false }])
    expect(cards.snapshot().c.cards[0]).toMatchObject({ id: start.agent_id, agentType: 'default', status: 'running', tools: 0 })
    cards.noteHook('c', { ...hooks.SubagentStop, agent_transcript_path: childPath }, parent)
    await cards.refresh([{ nodeId: 'c', transcriptPath: parent, busy: true, exited: false }])
    expect(cards.snapshot().c.cards[0]).toMatchObject({ status: 'done', description: 'pong', tools: 0 })
  })
})

describe('more of the same shapes', () => {
  test("a child whose own turn failed shows the error from its task_complete", () => {
    const failed = lines('subagent-child.jsonl').map((l) => {
      const j = JSON.parse(l)
      if (j.payload?.type === 'task_complete' && j.payload.turn_id !== j.payload.root_turn_id) j.payload.error = { message: 'Rate limit reached', codex_error_info: 'rate_limit_exceeded' }
      return JSON.stringify(j)
    })
    expect(foldCodexChild(emptyProgress(), failed.join('\n')).error).toBe('Rate limit reached')
  })

  test('a message sent to a Codex node is confirmed from its real UserMessage line', async () => {
    const { confirmDelivery } = await import('../../src/main/control/deliveryCheck')
    const file = join(temp(), 'r.jsonl')
    writeFileSync(file, '')
    const sent = 'Reply with just the word ready.'
    writeFileSync(file, lines('live-session.jsonl').map((l) => `${l}\n`).join(''))
    expect(await confirmDelivery({ path: file, from: 0, sent, timing: { confirmMs: 300, pollMs: 10 } })).toMatchObject({ result: 'confirmed' })
  })
})
