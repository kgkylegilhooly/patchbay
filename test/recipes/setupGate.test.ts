import { expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { planRestore } from '../../src/main/lifecycle'
import { createSetupGate } from '../../src/main/recipes/setupGate'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasNode, ClaudeNode, RunNode } from '../../src/shared/model'
import { fakeRunner, projectStore } from './fakes'

const box = { x: 0, y: 0, width: 600, height: 400, parentId: null, projectId: 'p1' }
const agent = (id: string, over: Partial<ClaudeNode> = {}): ClaudeNode => ({ ...box, id, kind: 'claude', title: id, cwd: 'C:\\x', sessionId: null, transcriptPath: null, after: [], ...over })
const step = (id: string): RunNode => ({ ...box, id, kind: 'run', title: `Step ${id}`, cwd: 'C:\\x', command: 'node launch-run.cjs plan.json' })

function setup(nodes: CanvasNode[] = [step('s1'), step('s2'), agent('impl'), agent('review')]) {
  const store = projectStore(nodes)
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const setupGate = createSetupGate({ store, tracker, runner, gate })
  const node = (id: string) => store.get().nodes.find((n) => n.id === id) as ClaudeNode
  const finishTurn = (id: string) => {
    tracker.apply(id, { type: 'hook', name: 'UserPromptSubmit' })
    tracker.apply(id, { type: 'hook', name: 'Stop' })
  }
  return { store, tracker, runner, gate, setupGate, node, finishTurn }
}

const wait = (steps: string[], after: string[] = []) => ({ steps, after, recipe: '"R" (built-in)' })

test('an agent stays queued until every setup step exits with code 0, then starts', () => {
  const { tracker, runner, setupGate, node } = setup()
  setupGate.hold('impl', wait(['s1', 's2']))
  expect(tracker.get('impl')).toBe('queued')
  runner.report('s1', { running: true })
  runner.exit('s1', 0)
  expect(runner.started).toEqual([])
  expect(node('impl').setupWait?.steps).toEqual(['s2'])
  runner.exit('s2', 0)
  expect(runner.started).toEqual(['impl'])
  expect(node('impl').setupWait).toBeUndefined()
})

test('a failed required step keeps its agents from starting, and says which step and why', () => {
  const { tracker, runner, setupGate, node } = setup()
  setupGate.hold('impl', wait(['s1']))
  setupGate.hold('review', wait(['s1'], ['impl']))
  runner.exit('s1', 2)
  expect(runner.started).toEqual([])
  expect(tracker.get('impl')).toBe('queued')
  expect(tracker.get('review')).toBe('queued')
  expect(node('impl').setupWait?.failed).toEqual({ step: 's1', title: 'Step s1', exitCode: 2, why: 'exit' })
  // Nothing else releases it, however much else happens.
  setupGate.evaluate()
  expect(runner.started).toEqual([])
})

test('running the failed step again and succeeding is the retry', () => {
  const { runner, setupGate, node } = setup()
  setupGate.hold('impl', wait(['s1']))
  runner.exit('s1', 1)
  expect(node('impl').setupWait?.failed?.exitCode).toBe(1)
  runner.report('s1', { running: true })
  expect(node('impl').setupWait?.failed).toBeUndefined()
  runner.report('s1', { running: false, exitCode: 0 })
  expect(runner.started).toEqual(['impl'])
})

test('a step stopped by the person, or closed, counts as failed', () => {
  const { store, runner, setupGate, node } = setup()
  setupGate.hold('impl', wait(['s1']))
  setupGate.hold('review', wait(['s2']))
  runner.report('s1', { running: true })
  runner.report('s1', { running: false, exitCode: 1, stoppedByYou: true })
  expect(node('impl').setupWait?.failed?.why).toBe('stopped')
  store.dispatch({ op: 'removeNodes', ids: ['s2'], at: 1 })
  expect(node('review').setupWait?.failed?.why).toBe('closed')
  expect(runner.started).toEqual([])
})

test('after setup, an agent that also starts after another waits for that agent next', () => {
  const { runner, setupGate, node, finishTurn } = setup()
  setupGate.hold('impl', wait(['s1']))
  setupGate.hold('review', wait(['s1'], ['impl']))
  runner.exit('s1', 0)
  expect(runner.started).toEqual(['impl'])
  expect(node('review').after).toEqual(['impl'])
  finishTurn('impl')
  expect(runner.started).toEqual(['impl', 'review'])
})

test('another agent finishing a turn never starts an agent still waiting for setup', () => {
  const { runner, setupGate, finishTurn } = setup()
  setupGate.hold('review', wait(['s1'], ['impl']))
  finishTurn('impl')
  expect(runner.started).toEqual([])
})

test('Start anyway clears the hold and starts it', async () => {
  const { runner, setupGate, node } = setup()
  setupGate.hold('impl', wait(['s1']))
  runner.exit('s1', 1)
  await setupGate.startAnyway('impl')
  expect(runner.started).toEqual(['impl'])
  expect(node('impl').setupWait).toBeUndefined()
})

test('a held agent stays held across a restart, failure and all', () => {
  const held = agent('impl', { setupWait: { ...wait(['s1']), failed: { step: 's1', title: 'Step s1', exitCode: 3, why: 'exit' } } })
  expect(planRestore({ version: 3, projects: [], activeProjectId: '', nodes: [step('s1'), held], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } })).toMatchObject({ claude: [], held: ['impl'] })
  const { tracker, runner, setupGate, node } = setup([step('s1'), held])
  setupGate.evaluate()
  expect(tracker.get('impl')).toBe('queued')
  expect(node('impl').setupWait?.failed?.exitCode).toBe(3)
  expect(runner.started).toEqual([])
  // A step that finished while the app was closed is reported from the host, and releases it.
  runner.report('s1', { running: false, exitCode: 0 })
  expect(runner.started).toEqual(['impl'])
})
