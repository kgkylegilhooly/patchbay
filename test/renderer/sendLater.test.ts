import { expect, test } from 'vitest'
import { armRefusal, canonicalSpec } from '../../src/core/trigger/arming'
import { laterTrigger, nextAtFor } from '../../src/renderer/sendLater'
import type { CanvasDoc, CanvasNode, TriggerNode } from '../../src/shared/model'

// F46: "check the deploy at 9" meant the trigger form and an arming review for one message.
const at = (h: number, m: number, day = 26): number => new Date(2026, 10, day, h, m).getTime()

test('a time today, or tomorrow once it has passed', () => {
  expect(nextAtFor('21:00', at(9, 30))).toBe(at(21, 0))
  expect(nextAtFor('09:00', at(9, 30))).toBe(at(9, 0, 27))
  // Within a minute of now is today too: it's what was meant by "in a moment".
  expect(nextAtFor('09:31', at(9, 30))).toBe(at(9, 31))
  expect(nextAtFor('25:00', at(9, 30))).toBeNull()
  expect(nextAtFor('', at(9, 30))).toBeNull()
})

test('the trigger it makes says when, goes once to that agent, and is one arming accepts as it is', () => {
  const agent = { id: 'a', kind: 'claude', title: 'Deploy watcher', x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p', cwd: 'C:\\w', sessionId: null, transcriptPath: null, after: [] } as CanvasNode
  const base = { id: 't', kind: 'trigger', title: 'Trigger', x: 420, y: 0, width: 280, height: 200, parentId: null, projectId: 'p', schedule: { type: 'interval', everyMs: 1 }, prompt: '', targetId: null, armedSpec: null, armedAt: null, nextAt: null, runs: [] } as unknown as TriggerNode
  const node = laterTrigger(base, agent.id, '  Check the deploy and tell me if it failed.  ', at(21, 0))
  expect(node).toMatchObject({ title: 'Send at 21:00', schedule: { type: 'once', at: at(21, 0) }, prompt: 'Check the deploy and tell me if it failed.', targetId: 'a' })
  const doc = { nodes: [agent, node], projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }] } as Pick<CanvasDoc, 'nodes' | 'projects'>
  expect(armRefusal(node, doc, at(9, 30))).toBeNull()
  expect(canonicalSpec(node)).toContain('Check the deploy')
})
