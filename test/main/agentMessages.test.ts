import { expect, test } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { sendToAgent } from '../../src/main/agentMessages'
import type { SendQueue } from '../../src/main/control/sendQueue'
import type { CanvasStore } from '../../src/shared/contract'
import type { AgentStatus, CanvasDoc, CanvasNode } from '../../src/shared/model'

const base = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const nodes: CanvasNode[] = [
  { ...base, id: 'a', kind: 'claude', title: 'Writer', cwd: 'C:\\r', sessionId: null, transcriptPath: null, after: [] },
  { ...base, id: 't', kind: 'terminal', title: 'Shell', cwd: 'C:\\r' }
]

function setup(status: AgentStatus = 'idle', answer: 'delivered' | 'queued' = 'delivered') {
  let doc: CanvasDoc = { version: 3, projects: [], activeProjectId: '', nodes, edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
  const store: CanvasStore = { get: () => doc, dispatch: (op) => (doc = reduce(doc, op)), subscribe: () => () => {} }
  const sent: Array<{ id: string; text: string }> = []
  const queue = { add: (id: string, item: { text: string }) => (sent.push({ id, text: item.text }), answer) } as unknown as SendQueue
  return { deps: { store, status: () => status, queue }, sent }
}

test('a review goes to an agent through the send queue, line breaks and all, without control keys', () => {
  const { deps, sent } = setup()
  expect(sendToAgent(deps, 'a', 'Review:\r\n- fix\x1b[2J it')).toEqual({ ok: true, queued: false })
  expect(sent).toEqual([{ id: 'a', text: 'Review:\n- fix[2J it' }])
})

test('a busy agent gets it later, and says so', () => {
  expect(sendToAgent(setup('working', 'queued').deps, 'a', 'hi')).toEqual({ ok: true, queued: true })
})

test.each([
  ['t', 'hi', /not an agent/],
  ['missing', 'hi', /not an agent/],
  ['a', '   \x07 ', /nothing to send/]
])('sending to %s is refused', (id, text, reason) => {
  const r = sendToAgent(setup().deps, id, text)
  expect(r.ok).toBe(false)
  expect(!r.ok && r.reason).toMatch(reason)
})

test('an exited agent refuses, since nothing would read it', () => {
  const r = sendToAgent(setup('exited').deps, 'a', 'hi')
  expect(!r.ok && r.reason).toMatch(/has exited/)
})
