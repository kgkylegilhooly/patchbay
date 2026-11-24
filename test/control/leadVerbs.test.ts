import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { createPromptWitness } from '../../src/main/control/promptWitness'
import { rpcSignal } from '../../src/main/control/rpcSignal'
import { RpcRefusal } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { AgentStop } from '../../src/shared/agentStop'
import type { CanvasNode } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, groupNode, memoryStore, terminalNode } from './fakes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay lead '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(extra: CanvasNode[] = []) {
  const store = memoryStore([claudeNode('me', { cwd: dir }), ...extra])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const host = fakeHost()
  const prompts = createPromptWitness()
  const stopped = new Map<string, AgentStop>()
  const verbs = createVerbs({
    store,
    runner,
    tracker,
    host,
    prompts,
    stops: { get: (id) => stopped.get(id) },
    gate: createAfterGate({ store, tracker, runner }),
    timing: { enterDelayMs: 0, settleMs: 5 },
    waitTiming: { pollMs: 5, graceMs: 60 },
    deliveryTiming: { confirmMs: 400, pollMs: 10 }
  })
  // Linked to whoever opened them, as open-agent links them, so members can report back.
  for (const n of extra) if (n.openedBy) store.dispatch({ op: 'addEdge', edge: { id: `link-${n.id}`, from: n.openedBy, to: n.id, kind: 'link' } })
  const status = (id: string, hook: string) => tracker.apply(id, { type: 'hook', name: hook })
  return { store, tracker, runner, host, prompts, stopped, verbs, status }
}

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'not refused',
    (e) => (e instanceof RpcRefusal ? e.message : `threw ${e}`)
  )

const team = () => [claudeNode('a', { openedBy: 'me', title: 'Alpha' }), claudeNode('b', { openedBy: 'me', title: 'Beta' })]

describe('wait --next', () => {
  test('a member already idle does not end it; the next turn to finish does', async () => {
    const { verbs, status } = setup(team())
    status('a', 'Stop') // idle, waiting for review
    status('b', 'UserPromptSubmit')
    let over = false
    const waiting = verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 }).then((r) => ((over = true), r))
    await new Promise((r) => setTimeout(r, 120))
    // The plain --any would have returned by now, after the grace.
    expect(over).toBe(false)
    status('b', 'Stop')
    expect(await waiting).toMatchObject({ done: true, next: { node: 'b', why: 'finished' }, nodes: { a: 'idle', b: 'idle' } })
  })

  test('the old --any still returns at once for an idle member', async () => {
    const { verbs, status } = setup(team())
    status('a', 'Stop')
    status('b', 'UserPromptSubmit')
    expect(await verbs('me', 'wait', { nodes: ['a', 'b'], any: true, timeout: 5 })).toMatchObject({ done: true, nodes: { a: 'idle' } })
  })

  test('a member that was idle counts once it starts and finishes a new turn', async () => {
    const { verbs, status } = setup(team())
    status('a', 'Stop')
    status('b', 'Stop')
    const waiting = verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 })
    status('a', 'UserPromptSubmit')
    await new Promise((r) => setTimeout(r, 20))
    status('a', 'Stop')
    expect(await waiting).toMatchObject({ done: true, next: { node: 'a', why: 'finished' } })
  })

  test('a message from one of them ends it, and is handed over in the reply', async () => {
    const { verbs, status, host, store } = setup(team())
    store.dispatch({ op: 'addEdge', edge: { id: 'l', from: 'me', to: 'a', kind: 'link' } })
    host.running.add('me')
    status('me', 'UserPromptSubmit') // the lead is busy running wait, so the report waits in its queue
    status('a', 'Stop')
    status('b', 'Stop')
    const waiting = verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 })
    await new Promise((r) => setTimeout(r, 20))
    status('a', 'UserPromptSubmit')
    await verbs('a', 'send', { node: 'me', text: 'Review fixes are committed.\nDetails in docs/plans/x.md' })
    expect(await waiting).toMatchObject({ done: true, next: { node: 'a', why: 'message' }, messages: [{ from: 'a', text: 'Review fixes are committed.\nDetails in docs/plans/x.md' }] })
  })

  test('a member closed while waiting, or stopped at its limit, ends it too', async () => {
    const { verbs, status, store, stopped, tracker } = setup(team())
    status('a', 'Stop')
    status('b', 'UserPromptSubmit')
    const closing = verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 })
    store.dispatch({ op: 'removeNodes', ids: ['a'], at: Date.now() })
    expect(await closing).toMatchObject({ done: true, next: { node: 'a', why: 'closed' } })

    const limited = verbs('me', 'wait', { nodes: ['b'], next: true, timeout: 5 })
    tracker.apply('b', { type: 'hook', name: 'StopFailure' })
    stopped.set('b', { kind: 'usage-limit', until: Date.now() + 3_600_000, at: Date.now() } as AgentStop)
    expect(await limited).toMatchObject({ done: true, next: { node: 'b', why: expect.stringMatching(/stopped|finished/) } })
  })

  test('gives up at the timeout, saying nothing changed', async () => {
    const { verbs, status } = setup(team())
    status('a', 'Stop')
    expect(await verbs('me', 'wait', { nodes: ['a'], next: true, timeout: 1 })).toMatchObject({ done: false, timedOut: true, nodes: { a: 'idle' } })
  })

  test('a report queued for the lead before the call returns at once (review H1)', async () => {
    const { verbs, status, host } = setup(team())
    host.running.add('me')
    status('me', 'UserPromptSubmit') // busy reading the last result, so the report waits in its queue
    status('a', 'UserPromptSubmit')
    await verbs('a', 'send', { node: 'me', text: 'report from a' })
    status('a', 'Stop')
    status('b', 'Stop')
    const started = Date.now()
    const r = await verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 2 })
    expect(r).toMatchObject({ done: true, next: { node: 'a', why: 'message' }, messages: [{ from: 'a', text: 'report from a' }] })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('a turn that ends between two calls is returned by the next one, and only once (review M1)', async () => {
    const { verbs, status } = setup(team())
    status('a', 'UserPromptSubmit')
    status('b', 'UserPromptSubmit')
    const first = verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 })
    status('a', 'Stop')
    expect(await first).toMatchObject({ next: { node: 'a', why: 'finished' } })
    // The lead is busy with a's result; b finishes meanwhile, without a message.
    status('b', 'Stop')
    const started = Date.now()
    expect(await verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 })).toMatchObject({ done: true, next: { node: 'b', why: 'finished' } })
    expect(Date.now() - started).toBeLessThan(1000)
    // Nothing new since: the same turn isn't handed out twice.
    expect(await verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 1 })).toMatchObject({ done: false, timedOut: true })
  })

  test('a wider wait after a narrower one never hands a turn back out (re-check M)', async () => {
    const { verbs, status } = setup(team())
    status('a', 'UserPromptSubmit')
    status('b', 'UserPromptSubmit')
    const narrow = verbs('me', 'wait', { nodes: ['a'], next: true, timeout: 5 })
    status('b', 'Stop') // b first, while only a is waited on
    status('a', 'Stop')
    expect(await narrow).toMatchObject({ next: { node: 'a' } })
    expect(await verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 2 })).toMatchObject({ next: { node: 'b' } })
    // a's turn was already returned, so nothing is left.
    expect(await verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 1 })).toMatchObject({ done: false, timedOut: true })
  })

  test('two turns that end together come back one call each, in order', async () => {
    const { verbs, status } = setup(team())
    status('a', 'UserPromptSubmit')
    status('b', 'UserPromptSubmit')
    status('b', 'Stop')
    status('a', 'Stop')
    // Both ended after the members started, but before the lead's first --next: that first call counts from itself.
    const waiting = verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 })
    status('b', 'UserPromptSubmit')
    status('a', 'UserPromptSubmit')
    status('b', 'Stop')
    status('a', 'Stop')
    expect(await waiting).toMatchObject({ next: { node: 'b' } })
    expect(await verbs('me', 'wait', { nodes: ['a', 'b'], next: true, timeout: 5 })).toMatchObject({ next: { node: 'a' } })
  })

  test('another caller keeps its own place', async () => {
    const { verbs, status, store } = setup([...team(), claudeNode('other')])
    store.dispatch({ op: 'addEdge', edge: { id: 'oa', from: 'other', to: 'a', kind: 'link' } })
    status('a', 'UserPromptSubmit')
    const mine = verbs('me', 'wait', { nodes: ['a'], next: true, timeout: 5 })
    const theirs = verbs('other', 'wait', { nodes: ['a'], next: true, timeout: 5 })
    status('a', 'Stop')
    expect(await mine).toMatchObject({ next: { node: 'a' } })
    expect(await theirs).toMatchObject({ next: { node: 'a' } })
  })

  test('--any and --next together are refused', async () => {
    const { verbs } = setup(team())
    expect(await refusal(verbs('me', 'wait', { nodes: ['a'], next: true, any: true }))).toMatch(/--any or --next/)
  })

  test('a terminal lead is woken by a message too (review L6)', async () => {
    const { verbs, status, host } = setup([terminalNode('lead'), claudeNode('w', { openedBy: 'lead' })])
    host.running.add('lead')
    status('w', 'Stop')
    const waiting = verbs('lead', 'wait', { nodes: ['w'], next: true, timeout: 5 })
    await new Promise((r) => setTimeout(r, 20))
    status('w', 'UserPromptSubmit')
    await verbs('w', 'send', { node: 'lead', text: 'echo done' }).catch(() => {})
    expect(await waiting).toMatchObject({ done: true, next: { node: 'w', why: 'message' } })
  })

  test('a wait whose caller went away leaves its reports queued, so they still arrive (review M3)', async () => {
    const { verbs, status, host } = setup(team())
    host.running.add('me')
    status('me', 'UserPromptSubmit')
    status('a', 'UserPromptSubmit')
    const gone = new AbortController()
    const waiting = rpcSignal.run(gone.signal, () => verbs('me', 'wait', { nodes: ['a'], next: true, timeout: 5 }))
    gone.abort() // the person stopped the tool call
    expect(await waiting).toEqual({ done: false, aborted: true })
    await verbs('a', 'send', { node: 'me', text: 'report nobody read' })
    status('a', 'Stop')
    // The next call gets the report, and then the finished turn: the dropped call moved nothing on.
    expect(await verbs('me', 'wait', { nodes: ['a'], next: true, timeout: 2 })).toMatchObject({ next: { why: 'message' }, messages: [{ text: 'report nobody read' }] })
    expect(await verbs('me', 'wait', { nodes: ['a'], next: true, timeout: 2 })).toMatchObject({ next: { why: 'finished' } })
    // A report left queued when no wait is there arrives as a prompt.
    await verbs('a', 'send', { node: 'me', text: 'report nobody read' })
    status('me', 'Stop')
    await vi.waitFor(() => expect(host.writes.some(([id, d]) => id === 'me' && d.includes('report nobody read'))).toBe(true))
  })

  test('a plain wait whose caller went away leaves them too', async () => {
    const { verbs, status, host } = setup(team())
    host.running.add('me')
    status('me', 'UserPromptSubmit')
    status('a', 'UserPromptSubmit')
    const gone = new AbortController()
    const waiting = rpcSignal.run(gone.signal, () => verbs('me', 'wait', { nodes: ['a'], timeout: 5 }))
    await verbs('a', 'send', { node: 'me', text: 'also unread' })
    gone.abort()
    status('a', 'Stop')
    await waiting.catch(() => {})
    status('me', 'Stop')
    await vi.waitFor(() => expect(host.writes.some(([id, d]) => id === 'me' && d.includes('also unread'))).toBe(true))
  })
})

describe('a group that is gone', () => {
  test('open-agent into the group a closed team left behind is refused, saying so, and makes nothing', async () => {
    const { verbs, store, runner } = setup()
    const made = (await verbs('me', 'spawn-team', { label: 'Pair', members: [{ name: 'a' }, { name: 'b' }] })) as { group: string; members: Record<string, string> }
    await verbs('me', 'close', { node: made.members.a })
    expect(await verbs('me', 'close', { node: made.members.b })).toMatchObject({ removedGroup: made.group })
    const before = store.get().nodes.length
    const started = runner.started.length
    const said = await refusal(verbs('me', 'open-agent', { group: made.group, prompt: 'review it' }))
    expect(said).toMatch(new RegExp(`Group "${made.group}" is gone: it was removed when its last member, "b", closed\\. Nothing was created\\.`))
    expect(store.get().nodes.length).toBe(before)
    expect(runner.started.length).toBe(started)
  })

  test('every verb that takes --group refuses a missing one the same way', async () => {
    const { verbs, store } = setup()
    const before = store.get().nodes.length
    for (const [verb, args] of [
      ['open-agent', {}],
      ['open-terminal', {}],
      ['sticky', { text: 'hi' }],
      ['open-whiteboard', {}],
      ['arrange', { layout: 'tidy' }]
    ] as const) {
      expect(await refusal(verbs('me', verb, { ...args, group: 'gone-id' }))).toMatch(/Group "gone-id" is gone.*Nothing was created/)
    }
    expect(store.get().nodes.length).toBe(before)
  })

  test('a node that is not a group is still refused as before', async () => {
    const { verbs } = setup([terminalNode('t', { openedBy: 'me' }), groupNode('g')])
    expect(await refusal(verbs('me', 'open-agent', { group: 't' }))).toMatch(/not a group/)
    expect(await verbs('me', 'sticky', { text: 'in g', group: 'g' })).toMatchObject({ id: expect.any(String) })
  })
})

describe('no silent no-ops', () => {
  test('arrange grid, row or column without --ids is refused rather than arranging nothing', async () => {
    const { verbs } = setup()
    expect(await refusal(verbs('me', 'arrange', { layout: 'row' }))).toMatch(/needs --ids/)
  })

  test('note --append with nothing in it is refused', async () => {
    const { verbs } = setup()
    const { id } = (await verbs('me', 'sticky', { text: 'board' })) as { id: string }
    expect(await refusal(verbs('me', 'note', { node: id, append: '  ' }))).toMatch(/nothing to add/)
  })

  test('linking two nodes already linked says so', async () => {
    const { verbs } = setup(team())
    expect(await verbs('me', 'link', { from: 'a', to: 'b' })).toEqual({ from: 'a', to: 'b' })
    expect(await verbs('me', 'link', { from: 'b', to: 'a' })).toEqual({ from: 'b', to: 'a', already: true })
  })
})

describe('send to an agent with no transcript yet', () => {
  const long = 'Please pick up the review findings in docs/review.md. '.repeat(10)

  test('is confirmed by the UserPromptSubmit hook that carries it', async () => {
    const { verbs, status, host, prompts } = setup([claudeNode('c', { openedBy: 'me' })])
    host.running.add('c')
    status('c', 'Stop')
    const write = host.write.bind(host)
    host.write = (id, data) => {
      write(id, data)
      // Claude Code submits it, and its hook reports the text, before any transcript is known.
      if (id === 'c' && data.includes('Please pick up')) setTimeout(() => prompts.heard('c', { hook_event_name: 'UserPromptSubmit', prompt: data.replace(/\x1b\[20[01]~/g, '') }), 20)
    }
    expect(await verbs('me', 'send', { node: 'c', text: long })).toEqual({ delivered: true, confirmed: true })
  })

  test('is confirmed from a transcript learned after it was typed', async () => {
    const { verbs, status, host, store } = setup([claudeNode('c', { openedBy: 'me' })])
    host.running.add('c')
    status('c', 'Stop')
    const transcript = join(dir, 'c.jsonl')
    const write = host.write.bind(host)
    host.write = (id, data) => {
      write(id, data)
      if (id !== 'c' || !data.includes('Please pick up')) return
      setTimeout(() => {
        writeFileSync(transcript, '')
        appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: data.replace(/\x1b\[20[01]~/g, '') } }) + '\n')
        store.dispatch({ op: 'patchNode', id: 'c', patch: { transcriptPath: transcript } })
      }, 20)
    }
    expect(await verbs('me', 'send', { node: 'c', text: long })).toEqual({ delivered: true, confirmed: true })
  })

  test('says it could not check only after neither showed up', async () => {
    const { verbs, status, host } = setup([claudeNode('c', { openedBy: 'me' })])
    host.running.add('c')
    status('c', 'Stop')
    expect(await verbs('me', 'send', { node: 'c', text: 'short' })).toMatchObject({ delivered: true, confirmed: false, problem: expect.stringMatching(/no transcript yet and didn't report the message submitted/) })
  })
})

test('the prompt witness keeps only what came after the mark', () => {
  const w = createPromptWitness()
  w.heard('x', { hook_event_name: 'UserPromptSubmit', prompt: 'old' })
  const mark = w.mark('x')
  w.heard('x', { hook_event_name: 'Stop' })
  w.heard('x', { hook_event_name: 'UserPromptSubmit', prompt: 'new' })
  expect(w.since('x', mark)).toEqual(['new'])
  expect(w.since('y', 0)).toEqual([])
})
