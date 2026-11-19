import { expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { createSendQueue } from '../../src/main/control/sendQueue'
import { createAgentStops } from '../../src/main/sessions/agentStops'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { AgentKind } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, memoryStore, terminalNode } from './fakes'

const LIMIT = { hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 12:30am" }

function setup({ enabled = ['claude', 'codex'] as AgentKind[] } = {}) {
  const store = memoryStore([
    claudeNode('lead'),
    claudeNode('author', { openedBy: 'lead', sessionId: 's1' }),
    claudeNode('reviewer', { openedBy: 'lead' }),
    claudeNode('stranger', { openedBy: 'someone' }),
    claudeNode('codex', { openedBy: 'lead', agent: 'codex' }),
    terminalNode('term', { openedBy: 'lead' })
  ])
  const tracker = createStatusTracker({ notify: () => {} })
  const host = fakeHost()
  const restarted: string[] = []
  const errors: Record<string, { code: 'resume-failed'; message: string }> = {}
  const runner = {
    ...fakeRunner(),
    async restartNode(id: string) {
      restarted.push(id)
      host.running.add(id)
    },
    errors: () => errors
  }
  const stops = createAgentStops({ tracker })
  const queue = createSendQueue({ host, tracker, exists: (id) => store.get().nodes.some((n) => n.id === id), timing: { enterDelayMs: 0, settleMs: 5 }, hold: stops })
  const verbs = createVerbs({
    store,
    runner,
    tracker,
    host,
    queue,
    stops,
    gate: createAfterGate({ store, tracker, runner }),
    waitTiming: { pollMs: 5, graceMs: 30 },
    deliveryTiming: { pollMs: 5, confirmMs: 10 },
    agents: () => ({ enabled, default: enabled[0] })
  })
  for (const id of ['author', 'reviewer', 'codex']) {
    host.running.add(id)
    tracker.apply(id, { type: 'launched' })
    tracker.apply(id, { type: 'hook', name: 'SessionStart' })
  }
  const limit = (id: string): void => {
    tracker.apply(id, { type: 'hook', name: 'UserPromptSubmit' })
    tracker.apply(id, { type: 'hook', name: 'StopFailure' })
    stops.noteHook(id, LIMIT)
  }
  return { store, tracker, host, verbs, limit, restarted, errors }
}

const refused = async (p: Promise<unknown>, pattern: RegExp) => {
  const e = await p.then(
    () => null,
    (err) => err
  )
  expect(e).toBeInstanceOf(RpcRefusal)
  expect(e.message).toMatch(pattern)
}

test('wait counts a node stopped at its usage limit as finished for now, and says why', async () => {
  const { verbs, limit, tracker } = setup()
  tracker.apply('author', { type: 'hook', name: 'UserPromptSubmit' })
  const waiting = verbs('lead', 'wait', { nodes: ['author'], timeout: 5 })
  limit('author')
  const r = (await waiting) as { done: boolean; nodes: Record<string, string>; stopped: Record<string, { kind: string; until: string; text: string }> }
  expect(r.done).toBe(true)
  expect(r.nodes).toEqual({ author: 'unknown' })
  expect(r.stopped.author).toMatchObject({ kind: 'usage-limit', until: expect.stringMatching(/T/) })
  expect(r.stopped.author.text).toMatch(/^Usage limit until 00:30\. Messages and trigger prompts for it wait until then/)
})

test('wait returns for a stopped node even with a message waiting for it', async () => {
  const { verbs, limit } = setup()
  limit('author')
  expect(await verbs('lead', 'send', { node: 'author', text: 'next' })).toMatchObject({ delivered: false, queued: true, held: expect.stringMatching(/^Usage limit until 00:30/) })
  expect(await verbs('lead', 'wait', { nodes: ['author'], timeout: 2 })).toMatchObject({ done: true, stopped: { author: { kind: 'usage-limit' } } })
})

test('list gives a stopped node a stopped entry beside its status, and others none', async () => {
  const { verbs, limit } = setup()
  limit('author')
  const { nodes } = (await verbs('lead', 'list', {})) as { nodes: Array<{ id: string; status?: string; stopped?: unknown }> }
  expect(nodes.find((n) => n.id === 'author')).toMatchObject({ status: 'unknown', stopped: { kind: 'usage-limit', text: expect.any(String) } })
  expect(nodes.find((n) => n.id === 'reviewer')).not.toHaveProperty('stopped')
})

test('restart brings back an exited agent the caller opened, resuming its conversation', async () => {
  const { verbs, tracker, host, restarted } = setup()
  host.running.delete('author')
  tracker.apply('author', { type: 'process-exit' })
  expect(await verbs('lead', 'restart', { node: 'author' })).toEqual({ id: 'author', restarted: true, agent: 'claude', resumed: true })
  expect(restarted).toEqual(['author'])
})

test('restart refuses a node the caller did not open, one still running, a terminal, and stops nothing', async () => {
  const { verbs, tracker, host, restarted } = setup()
  host.running.delete('stranger')
  tracker.apply('stranger', { type: 'process-exit' })
  await refused(verbs('lead', 'restart', { node: 'stranger' }), /you didn't open it/)
  await refused(verbs('lead', 'restart', { node: 'author' }), /still running \(idle\)/)
  await refused(verbs('lead', 'restart', { node: 'term' }), /only brings back agent nodes/)
  await refused(verbs('author', 'restart', { node: 'reviewer' }), /you didn't open it/)
  expect(restarted).toEqual([])
})

test('restart respects Settings > Agents, and reports a start that failed', async () => {
  const { verbs, tracker, host, restarted, errors } = setup({ enabled: ['claude'] })
  host.running.delete('codex')
  tracker.apply('codex', { type: 'process-exit' })
  await refused(verbs('lead', 'restart', { node: 'codex' }), /Can't restart node "codex": .*Codex/)
  expect(restarted).toEqual([])
  host.running.delete('reviewer')
  tracker.apply('reviewer', { type: 'process-exit' })
  errors.reviewer = { code: 'resume-failed', message: 'Claude could not reopen this conversation.' }
  await refused(verbs('lead', 'restart', { node: 'reviewer' }), /didn't start: Claude could not reopen/)
})

test('a lead links a reviewer to the author it opened, so the reviewer can send to it; nothing else', async () => {
  const { verbs, store } = setup()
  await refused(verbs('reviewer', 'send', { node: 'author', text: 'findings' }), /isn't linked to you/)
  expect(await verbs('lead', 'link', { from: 'reviewer', to: 'author' })).toEqual({ from: 'reviewer', to: 'author' })
  expect(await verbs('reviewer', 'send', { node: 'author', text: 'findings' })).toMatchObject({ delivered: true })
  await refused(verbs('lead', 'link', { from: 'reviewer', to: 'stranger' }), /"stranger"/)
  await refused(verbs('reviewer', 'link', { from: 'author', to: 'codex' }), /"author"/)
  expect(store.get().edges.filter((e) => e.kind === 'link').map((e) => [e.from, e.to])).toEqual([['reviewer', 'author']])
})
