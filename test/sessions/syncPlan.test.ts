import { describe, expect, test, vi } from 'vitest'
import {
  createSessionSync,
  OUTPUT_QUIET_MS,
  planSync,
  RECENT_EXIT_MS,
  STALE_STARTING_MS,
  STALE_WORKING_MS,
  statusFromTranscript,
  type SyncInput,
  type SyncNodeView
} from '../../src/main/sessions/sessionSync'
import type { HostedSession } from '../../src/main/sessions/hostProtocol'

const NOW = 10_000_000
const live = (id: string, pid: number | null = 100): HostedSession => ({ id, pid, running: true, exitCode: null, exitedAt: null })
const ended = (id: string): HostedSession => ({ id, pid: null, running: false, exitCode: 0, exitedAt: 1 })
const agent = (id: string, shown: SyncNodeView['shown']): SyncNodeView => ({ id, kind: 'claude', title: id, shown })

const input = (over: Partial<SyncInput>): SyncInput => ({
  nodes: [],
  sessions: [],
  alive: () => true,
  now: NOW,
  lastHeard: () => NOW,
  lastOutput: () => NOW,
  ...over
})

describe('planSync', () => {
  test('a node and host that agree need nothing', () => {
    const plan = planSync(input({ nodes: [agent('a', 'idle'), agent('b', 'exited')], sessions: [live('a'), ended('b')] }))
    expect(plan).toMatchObject({ reattach: [], gone: [], orphans: [], stale: [] })
    expect(plan.rows).toEqual([expect.objectContaining({ id: 'a', running: true, alive: true, problem: null })])
  })

  test('shown as ended while the host runs it and its process is there: shown again', () => {
    const plan = planSync(input({ nodes: [agent('a', 'exited'), { id: 't', kind: 'terminal', title: 't', shown: 'exited' }], sessions: [live('a'), live('t')], lastHeard: () => NOW - RECENT_EXIT_MS }))
    expect(plan.reattach).toEqual(['a', 't'])
    expect(plan.rows.map((r) => r.problem)).toEqual(['shown-exited', 'shown-exited'])
  })

  test('an agent that said it was ending a moment ago is left to finish, not shown as still running', () => {
    const plan = planSync(input({ nodes: [agent('a', 'exited')], sessions: [live('a')], lastHeard: () => NOW - 2000 }))
    expect(plan.reattach).toEqual([])
    expect(plan.rows).toEqual([expect.objectContaining({ id: 'a', problem: null })])
  })

  test('counted as running with its process gone: marked as ended, whatever the canvas shows', () => {
    const plan = planSync(input({ nodes: [agent('a', 'working')], sessions: [live('a', 7)], alive: (pid) => pid !== 7 }))
    expect(plan.gone).toEqual(['a'])
    expect(plan.reattach).toEqual([])
  })

  test('a start still under way has no pid yet, and is left alone', () => {
    const plan = planSync(input({ nodes: [agent('a', 'starting')], sessions: [live('a', null)], lastHeard: () => 0, lastOutput: () => undefined }))
    expect(plan).toMatchObject({ reattach: [], gone: [], stale: [] })
  })

  test('a session with no node is reported as an orphan, and nothing ends it', () => {
    const plan = planSync(input({ sessions: [live('ghost'), ended('old')] }))
    expect(plan.orphans).toEqual(['ghost'])
    expect(plan.gone).toEqual([])
    expect(plan.rows).toEqual([expect.objectContaining({ id: 'ghost', title: null, problem: 'orphan' })])
  })

  test('starting long past its last word, with its screen still: stale', () => {
    const quiet = { lastHeard: () => NOW - STALE_STARTING_MS, lastOutput: () => NOW - OUTPUT_QUIET_MS }
    expect(planSync(input({ nodes: [agent('a', 'starting')], sessions: [live('a')], ...quiet })).stale).toEqual(['a'])
  })

  test('working is given far longer than starting before it counts as stale', () => {
    const at = (heardAgo: number) => planSync(input({ nodes: [agent('a', 'working')], sessions: [live('a')], lastHeard: () => NOW - heardAgo, lastOutput: () => undefined })).stale
    expect(at(STALE_STARTING_MS)).toEqual([])
    expect(at(STALE_WORKING_MS)).toEqual(['a'])
  })

  test('a screen still drawing is a program still busy, however quiet its hooks', () => {
    const plan = planSync(input({ nodes: [agent('a', 'working')], sessions: [live('a')], lastHeard: () => 0, lastOutput: () => NOW - 1000 }))
    expect(plan.stale).toEqual([])
  })

  test('only starting and working can go stale: idle, needs-you and unknown are waiting on purpose', () => {
    for (const shown of ['idle', 'needs-you', 'unknown'] as const) {
      expect(planSync(input({ nodes: [agent('a', shown)], sessions: [live('a')], lastHeard: () => 0, lastOutput: () => undefined })).stale).toEqual([])
    }
  })

  test('terminals never go stale: they have no hooks', () => {
    const plan = planSync(input({ nodes: [{ id: 't', kind: 'terminal', title: 't', shown: null }], sessions: [live('t')], lastHeard: () => 0, lastOutput: () => undefined }))
    expect(plan.stale).toEqual([])
  })
})

describe('statusFromTranscript', () => {
  const line = (o: object) => JSON.stringify(o)
  const said = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })
  const calls = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } })
  const result = line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } })

  test('the agent had the last word and nothing is waiting: idle', () => {
    expect(statusFromTranscript([calls, result, said])).toBe('idle')
  })

  test('a call still waiting, a result it has yet to answer, or nothing at all: unknown, which claims nothing', () => {
    expect(statusFromTranscript([said, calls])).toBe('unknown')
    expect(statusFromTranscript([calls, result])).toBe('unknown')
    expect(statusFromTranscript([])).toBe('unknown')
    expect(statusFromTranscript(null)).toBe('unknown')
  })

  test('side conversations, bookkeeping and partial lines are passed over', () => {
    const side = line({ type: 'user', isSidechain: true, message: { content: 'sub' } })
    expect(statusFromTranscript([said, side, line({ type: 'summary' }), '{"type":"user","mess'])).toBe('idle')
  })
})

describe('the sync service', () => {
  function service(over: { sessions?: HostedSession[]; nodes?: SyncNodeView[]; alive?: (pid: number) => boolean; transcript?: string[] | null } = {}) {
    let now = NOW
    const deps = {
      nodes: () => over.nodes ?? [],
      host: { sessions: () => over.sessions ?? [], refresh: vi.fn(async () => over.sessions ?? []), kill: vi.fn(async () => {}) },
      reattach: vi.fn(),
      transcript: vi.fn(async () => over.transcript ?? null),
      seed: vi.fn(),
      since: () => NOW - STALE_WORKING_MS,
      onReport: vi.fn(),
      alive: over.alive ?? (() => true),
      now: () => now
    }
    const sync = createSessionSync(deps)
    return { sync, deps, later: (ms: number) => void (now += ms) }
  }

  test('asks the host, puts each disagreement right, and reports', async () => {
    const { sync, deps } = service({
      nodes: [agent('shown-ended', 'exited'), agent('stuck', 'working')],
      sessions: [live('shown-ended', 1), live('dead', 2), live('stuck', 3), live('ghost', 4)],
      alive: (pid) => pid !== 2,
      transcript: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })]
    })
    const report = await sync.check('test')
    expect(deps.host.refresh).toHaveBeenCalledOnce()
    expect(deps.reattach).toHaveBeenCalledWith('shown-ended')
    expect(deps.host.kill).toHaveBeenCalledExactlyOnceWith('dead')
    expect(deps.seed).toHaveBeenCalledWith('stuck', 'idle')
    expect(report?.hostReached).toBe(true)
    expect(report?.rows.find((r) => r.id === 'ghost')?.problem).toBe('orphan')
    expect(deps.onReport).toHaveBeenCalledWith(report)
  })

  test('a stale start is set to unknown, never to idle from an older run\'s transcript', async () => {
    const { sync, deps } = service({
      nodes: [agent('slow', 'starting')],
      sessions: [live('slow')],
      transcript: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done last time.' }] } })]
    })
    await sync.check('test')
    expect(deps.seed).toHaveBeenCalledExactlyOnceWith('slow', 'unknown')
    expect(deps.transcript).not.toHaveBeenCalled()
  })

  test('the orphan is never ended by a check', async () => {
    const { sync, deps } = service({ sessions: [live('ghost')] })
    await sync.check('test')
    expect(deps.host.kill).not.toHaveBeenCalled()
  })

  test('checks closer together than the gap reuse the last one, unless forced', async () => {
    const { sync, deps, later } = service()
    await sync.check('timer')
    await sync.check('focus')
    expect(deps.host.refresh).toHaveBeenCalledTimes(1)
    await sync.check('settings', true)
    expect(deps.host.refresh).toHaveBeenCalledTimes(2)
    later(60_000)
    await sync.check('timer')
    expect(deps.host.refresh).toHaveBeenCalledTimes(3)
  })

  test('a hook heard just now keeps a long-working agent from counting as stale', async () => {
    const { sync, deps } = service({ nodes: [agent('a', 'working')], sessions: [live('a')] })
    sync.heard('a')
    await sync.check('test')
    expect(deps.seed).not.toHaveBeenCalled()
  })

  test('output just now does too', async () => {
    const { sync, deps } = service({ nodes: [agent('a', 'working')], sessions: [live('a')] })
    sync.output('a')
    await sync.check('test')
    expect(deps.seed).not.toHaveBeenCalled()
  })
})
