import { expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { ClaudeNode } from '../../src/shared/model'
import { claudeNode, fakeRunner, memoryStore } from './fakes'

function setup(nodes = [claudeNode('up1'), claudeNode('up2'), claudeNode('down')]) {
  const store = memoryStore(nodes)
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const after = (id: string) => (store.get().nodes.find((n) => n.id === id) as ClaudeNode).after
  const finishTurn = (id: string) => {
    tracker.apply(id, { type: 'hook', name: 'UserPromptSubmit' })
    tracker.apply(id, { type: 'hook', name: 'Stop' })
  }
  return { store, tracker, runner, gate, after, finishTurn }
}

test('an armed node stays queued until every upstream finishes a turn', () => {
  const { tracker, runner, gate, after, finishTurn } = setup()
  gate.arm('down', ['up1', 'up2'])
  expect(tracker.get('down')).toBe('queued')
  expect(runner.started).toEqual([])

  finishTurn('up1')
  expect(runner.started).toEqual([])
  expect(after('down')).toEqual(['up2'])

  finishTurn('up2')
  expect(runner.started).toEqual(['down'])
  expect(after('down')).toEqual([])
})

test('a node is started once, however many changes follow its release', () => {
  const { runner, gate, finishTurn } = setup()
  gate.arm('down', ['up1'])
  finishTurn('up1')
  finishTurn('up1')
  gate.evaluate()
  expect(runner.started).toEqual(['down'])
})

test('an upstream that already finished a turn releases at once', () => {
  const { runner, gate, after, finishTurn } = setup()
  finishTurn('up1')
  gate.arm('down', ['up1'])
  expect(runner.started).toEqual(['down'])
  expect(after('down')).toEqual([])
})

test('an upstream that exited without finishing holds, and startNow overrides', () => {
  const { tracker, runner, gate, after } = setup()
  gate.arm('down', ['up1'])
  tracker.apply('up1', { type: 'hook', name: 'UserPromptSubmit' })
  tracker.apply('up1', { type: 'process-exit' })
  gate.evaluate()
  expect(runner.started).toEqual([])
  expect(tracker.get('down')).toBe('queued')

  gate.startNow('down')
  expect(runner.started).toEqual(['down'])
  expect(after('down')).toEqual([])
})

test('an upstream reaching idle from startup alone has not finished a turn', () => {
  const { tracker, runner, gate } = setup()
  gate.arm('down', ['up1'])
  tracker.apply('up1', { type: 'launched' })
  tracker.apply('up1', { type: 'hook', name: 'SessionStart' })
  expect(tracker.get('up1')).toBe('idle')
  expect(runner.started).toEqual([])
})

test('an armed node stays armed after a restart', () => {
  // A new launch: fresh tracker and gate over a doc whose node still lists one unfinished upstream.
  const { tracker, runner, gate, after, finishTurn } = setup([
    claudeNode('up1'),
    claudeNode('down', { after: ['up1'] })
  ])
  gate.evaluate()
  expect(runner.started).toEqual([])
  expect(tracker.get('down')).toBe('queued')
  expect(after('down')).toEqual(['up1'])

  finishTurn('up1')
  expect(runner.started).toEqual(['down'])
})

test('a released upstream stays released after a restart', () => {
  const first = setup()
  first.gate.arm('down', ['up1', 'up2'])
  first.finishTurn('up1')

  const reloaded = first.store.get().nodes
  const second = setup(reloaded as ClaudeNode[])
  second.gate.evaluate()
  expect(second.after('down')).toEqual(['up2'])
  second.finishTurn('up2')
  expect(second.runner.started).toEqual(['down'])
})

test('closing the last upstream empties the list, which releases the node', () => {
  const { store, runner, gate } = setup()
  gate.arm('down', ['up1'])
  store.dispatch({ op: 'removeNodes', ids: ['up1'], at: 1 })
  expect(runner.started).toEqual(['down'])
})

test('closing an armed node forgets it', () => {
  const { store, runner, gate, finishTurn } = setup()
  gate.arm('down', ['up1'])
  store.dispatch({ op: 'removeNodes', ids: ['down'], at: 1 })
  finishTurn('up1')
  expect(runner.started).toEqual([])
})

test('startNow on a node that is not held does not start it twice', () => {
  const { runner, gate, finishTurn } = setup()
  gate.arm('down', ['up1'])
  gate.startNow('down')
  finishTurn('up1')
  expect(runner.started).toEqual(['down'])
})
