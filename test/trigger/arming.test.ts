import { describe, expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { migrate } from '../../src/core/persist/docStore'
import { armRefusal, canonicalSpec, isArmed, targetsFor } from '../../src/core/trigger/arming'
import type { CanvasDoc, CanvasNode, TriggerNode } from '../../src/shared/model'
import { claudeNode, terminalNode } from '../control/fakes'
import { triggerNode } from './fixtures'

const doc = (nodes: CanvasNode[]): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p',
  nodes: nodes.map((n) => ({ ...n, projectId: n.projectId ?? 'p' })),
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
})

const armed = (over: Partial<TriggerNode> = {}): TriggerNode => {
  const n = triggerNode('tr', over)
  return { ...n, armedSpec: canonicalSpec(n), armedAt: 1, nextAt: 60_001 }
}
const trig = (d: CanvasDoc) => d.nodes.find((n) => n.id === 'tr') as TriggerNode

describe('arming is tied to exactly what was agreed', () => {
  test('a trigger is armed only while its content matches', () => {
    const n = armed()
    expect(isArmed(n)).toBe(true)
    expect(isArmed({ ...n, prompt: 'something else' })).toBe(false)
    expect(isArmed({ ...n, targetId: 'other' })).toBe(false)
    expect(isArmed({ ...n, schedule: { type: 'interval', everyMs: 120_000 } })).toBe(false)
    expect(isArmed(triggerNode('x'))).toBe(false)
  })

  test('spacing in a cron expression is not a change', () => {
    const a = canonicalSpec(triggerNode('a', { schedule: { type: 'cron', expr: '0 9 * * *' } }))
    expect(canonicalSpec(triggerNode('a', { schedule: { type: 'cron', expr: ' 0  9 * * * ' } }))).toBe(a)
  })

  test('a new trigger starts disarmed with no runs, whatever it says', () => {
    const d = reduce(doc([terminalNode('t')]), { op: 'addNode', node: armed({ runs: [{ id: 'r', at: 1, source: 'manual', outcome: 'delivered' }] }) })
    expect(trig(d)).toMatchObject({ armedSpec: null, armedAt: null, nextAt: null, runs: [] })
  })

  test('editing the schedule, prompt or target disarms it', () => {
    for (const patch of [{ prompt: 'new' }, { targetId: 'c' }, { schedule: { type: 'cron' as const, expr: '* * * * *' } }]) {
      const d = reduce(doc([terminalNode('t'), claudeNode('c'), armed()]), { op: 'patchNode', id: 'tr', patch })
      expect(trig(d).armedSpec, JSON.stringify(patch)).toBeNull()
      expect(trig(d).nextAt).toBeNull()
    }
  })

  test('moving or renaming it does not', () => {
    const d = reduce(doc([terminalNode('t'), armed()]), { op: 'patchNode', id: 'tr', patch: { x: 50, title: 'Nightly' } })
    expect(isArmed(trig(d))).toBe(true)
  })

  test('an ordinary patch cannot arm it or rewrite its runs', () => {
    const n = triggerNode('tr')
    const d = reduce(doc([terminalNode('t'), n]), {
      op: 'patchNode',
      id: 'tr',
      patch: { armedSpec: canonicalSpec(n), armedAt: 1, nextAt: 2, runs: [{ id: 'r', at: 1, source: 'manual', outcome: 'delivered' }] } as Partial<CanvasNode>
    })
    expect(trig(d)).toMatchObject({ armedSpec: null, nextAt: null, runs: [] })
  })

  test('setTriggerState changes only the state, and only on a trigger', () => {
    const d = reduce(doc([terminalNode('t'), triggerNode('tr')]), { op: 'setTriggerState', id: 'tr', state: { nextAt: 5, prompt: 'x' } as never })
    expect(trig(d).nextAt).toBe(5)
    expect(trig(d).prompt).toBe('check the build')
    const t = doc([terminalNode('t')])
    expect(reduce(t, { op: 'setTriggerState', id: 't', state: { nextAt: 5 } })).toBe(t)
  })

  test('closing its target disarms it and clears the target', () => {
    const d = reduce(doc([terminalNode('t'), armed()]), { op: 'removeNodes', ids: ['t'], at: 1 })
    expect(trig(d)).toMatchObject({ targetId: null, armedSpec: null })
  })
})

describe('armRefusal', () => {
  const t0 = 1_000_000
  const refusal = (over: Partial<TriggerNode>, nodes: CanvasNode[] = [terminalNode('t')]) => {
    const d = doc([...nodes, triggerNode('tr', over)])
    return armRefusal(trig(d), d, t0)
  }

  test('allows a complete trigger', () => {
    expect(refusal({})).toBeNull()
  })

  test.each([
    [{ prompt: '  ' }, /prompt/],
    [{ prompt: 'x'.repeat(20001) }, /too long/],
    [{ targetId: null }, /Choose what it sends to/],
    [{ targetId: 'gone' }, /gone/],
    [{ schedule: { type: 'interval' as const, everyMs: 1000 } }, /at least 5 seconds/],
    [{ schedule: { type: 'cron' as const, expr: 'bad' } }, /5 fields/],
    [{ schedule: { type: 'once' as const, at: 10 } }, /passed/]
  ])('refuses %j', (over, message) => {
    expect(refusal(over)).toMatch(message)
  })

  test('refuses a note, group or run node as a target', () => {
    const sticky: CanvasNode = { id: 's', kind: 'sticky', title: 's', text: '', x: 0, y: 0, width: 1, height: 1, parentId: null }
    expect(refusal({ targetId: 's' }, [sticky])).toMatch(/gone/)
  })

  test('never targets a browser node, which has no session to type into', () => {
    const page: CanvasNode = { id: 'b', kind: 'browser', title: 'b', url: 'about:blank', x: 0, y: 0, width: 1, height: 1, parentId: null }
    expect(refusal({ targetId: 'b' }, [page])).toMatch(/gone/)
    const d = doc([page, terminalNode('t'), triggerNode('tr')])
    expect(targetsFor(d, trig(d)).map((n) => n.id)).toEqual(['t'])
  })

  test('refuses a target in another project', () => {
    expect(refusal({}, [terminalNode('t', { projectId: 'q' })])).toMatch(/another project/)
  })

  test('targetsFor lists terminals and Claude sessions in its project', () => {
    const d = doc([terminalNode('t'), claudeNode('c'), terminalNode('far', { projectId: 'q' }), triggerNode('tr')])
    expect(targetsFor(d, trig(d)).map((n) => n.id)).toEqual(['t', 'c'])
  })
})

describe('saving', () => {
  test('a trigger and a launch.json run node load back, with no new version', () => {
    const d = doc([terminalNode('t'), armed(), { id: 'r', kind: 'run', title: 'r', cwd: 'C:\\x', command: 'node a.js', launch: { folder: 'C:\\x', name: 'App' }, x: 0, y: 0, width: 1, height: 1, parentId: null }])
    const back = migrate(JSON.parse(JSON.stringify(d)))
    expect(back.version).toBe(3)
    expect(trig(back)).toEqual(trig(d))
  })

  test('a malformed trigger is refused rather than loaded', () => {
    const d = doc([{ ...triggerNode('tr'), schedule: { type: 'weekly' } } as unknown as CanvasNode])
    expect(migrate(JSON.parse(JSON.stringify(d))).nodes).toEqual([])
  })
})
