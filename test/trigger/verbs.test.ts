import { expect, test } from 'vitest'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { TriggerNode } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, memoryStore, terminalNode } from '../control/fakes'
import { triggerNode } from './fixtures'

function setup() {
  const t = triggerNode('tr', { projectId: 'p' })
  const store = memoryStore([claudeNode('me', { projectId: 'p' }), terminalNode('t', { projectId: 'p' }), t])
  store.dispatch({ op: 'setTriggerState', id: 'tr', state: { armedSpec: canonicalSpec(t), nextAt: 5 } })
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const verbs = createVerbs({ store, runner, tracker, host: fakeHost(), gate: createAfterGate({ store, tracker, runner }) })
  return { store, verbs, trig: () => store.get().nodes.find((n) => n.id === 'tr') as TriggerNode }
}

test('no verb arms, disarms, edits or fires a trigger', async () => {
  const { verbs } = setup()
  for (const verb of ['arm', 'arm-trigger', 'disarm-trigger', 'run-trigger', 'trigger', 'set-trigger']) {
    await expect(verbs('me', verb, { node: 'tr' })).rejects.toBeInstanceOf(RpcRefusal)
  }
})

test('an agent can list triggers, but not read their prompts', async () => {
  const { verbs } = setup()
  const listed = (await verbs('me', 'list', {})) as { nodes: Array<Record<string, unknown>> }
  const entry = listed.nodes.find((n) => n.id === 'tr')
  expect(entry).toMatchObject({ kind: 'trigger', trigger: { armed: true, schedule: 'Every minute', target: 't', nextAt: 5, lastRun: null } })
  expect(JSON.stringify(entry)).not.toContain('check the build')
  await expect(verbs('me', 'read', { node: 'tr' })).rejects.toThrow(/isn't linked to you/)
})

test('what an agent can do to any node leaves a trigger as it was agreed', async () => {
  const { verbs, trig } = setup()
  await verbs('me', 'rename', { node: 'tr', title: 'Renamed' })
  await verbs('me', 'arrange', { ids: ['tr'], layout: 'row' })
  expect(trig().armedSpec).toBe(canonicalSpec(trig()))
  await expect(verbs('me', 'link', { from: 'tr', to: 't' })).rejects.toThrow(/only link yourself and nodes you opened/)
  await expect(verbs('me', 'close', { node: 'tr' })).rejects.toThrow(/didn't open it/)
  await expect(verbs('me', 'send', { node: 'tr', text: 'x' })).rejects.toThrow()
})
