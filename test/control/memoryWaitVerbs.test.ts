import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { createPromptWitness } from '../../src/main/control/promptWitness'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { NodeError } from '../../src/shared/contract'
import { claudeNode, fakeHost, fakeRunner, memoryStore } from './fakes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay memory wait '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const WAIT = 'Waiting for memory: Windows has 1.0 GB of 40.0 GB left to give programs.'

/** A runner that holds the starts named in `holds`, as the real one does while memory is short. */
function setup(holds: (title: string) => boolean) {
  const store = memoryStore([claudeNode('me', { cwd: dir })])
  const tracker = createStatusTracker({ notify: () => {} })
  const errors: Record<string, NodeError> = {}
  const base = fakeRunner()
  const runner = {
    ...base,
    async startNode(id: string) {
      const node = store.get().nodes.find((n) => n.id === id)
      if (node && holds(node.title)) {
        errors[id] = { code: 'spawn-failed', message: WAIT, fix: 'memory' }
        // As the real runner marks a start it holds.
        tracker.apply(id, { type: 'process-exit' })
      } else await base.startNode(id)
    },
    errors: () => errors
  }
  const verbs = createVerbs({
    store,
    runner,
    tracker,
    host: fakeHost(),
    prompts: createPromptWitness(),
    stops: { get: () => undefined },
    gate: createAfterGate({ store, tracker, runner }),
    timing: { enterDelayMs: 0, settleMs: 5 },
    waitTiming: { pollMs: 5, graceMs: 60 },
    deliveryTiming: { confirmMs: 400, pollMs: 10 }
  })
  return { verbs, tracker, errors }
}

test('open-agent says when the agent waits for memory, so a lead does not take it for one that exited', async () => {
  const { verbs } = setup(() => true)
  expect(await verbs('me', 'open-agent', { prompt: 'go', title: 'W' })).toEqual({ id: expect.any(String), waitingForMemory: WAIT })
})

test('spawn-team names the members waiting for memory, and says nothing when none are', async () => {
  const held = setup((title) => title === 'b')
  expect(await held.verbs('me', 'spawn-team', { label: 'T', members: [{ name: 'a' }, { name: 'b' }] })).toMatchObject({ waitingForMemory: { members: ['b'], reason: WAIT } })
  const free = setup(() => false)
  expect(await free.verbs('me', 'spawn-team', { label: 'T', members: [{ name: 'a' }] })).not.toHaveProperty('waitingForMemory')
})

test('wait does not take an agent waiting for memory for one that finished, and says it waits', async () => {
  const { verbs, tracker, errors } = setup(() => true)
  const { id } = (await verbs('me', 'open-agent', { prompt: 'go', title: 'W' })) as { id: string }
  expect(await verbs('me', 'wait', { nodes: [id], timeout: 1 })).toMatchObject({ done: false, timedOut: true, waitingForMemory: { [id]: WAIT } })

  // Memory frees up: it starts, works and finishes its turn, and the wait ends then.
  const waiting = verbs('me', 'wait', { nodes: [id], timeout: 5 })
  delete errors[id]
  tracker.apply(id, { type: 'launched' })
  tracker.apply(id, { type: 'hook', name: 'UserPromptSubmit' })
  await new Promise((r) => setTimeout(r, 30))
  tracker.apply(id, { type: 'hook', name: 'Stop' })
  const over = (await waiting) as Record<string, unknown>
  expect(over).toMatchObject({ done: true, nodes: { [id]: 'idle' } })
  expect(over).not.toHaveProperty('waitingForMemory')
})
