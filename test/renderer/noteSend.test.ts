import { describe, expect, test } from 'vitest'
import { linkedAgents, sendSummary, sendTitle } from '../../src/renderer/noteSend'
import type { CanvasDoc, CanvasNode, Edge } from '../../src/shared/model'

const at = { x: 0, y: 0, width: 300, height: 200, parentId: null }
const agent = (id: string, title: string): CanvasNode => ({ ...at, id, kind: 'claude', title, cwd: 'C:\\w', sessionId: null, transcriptPath: null, after: [] })
const doc = (nodes: CanvasNode[], edges: Edge[]): CanvasDoc => ({ version: 3, projects: [], activeProjectId: '', nodes, edges, closed: [], viewport: { x: 0, y: 0, zoom: 1 } })

describe('linkedAgents', () => {
  test('the agents a cable joins the note to, either way round; not ones it opened or terminals', () => {
    const nodes = [
      { ...at, id: 'n', kind: 'sticky', title: 'Run tests', text: 'Run the tests and fix failures.' } as CanvasNode,
      agent('a', 'Builder'),
      agent('b', 'Reviewer'),
      agent('c', 'Other'),
      { ...at, id: 't', kind: 'terminal', title: 'Shell', cwd: 'C:\\w' } as CanvasNode
    ]
    const edges: Edge[] = [
      { id: 'e1', from: 'n', to: 'a', kind: 'link' },
      { id: 'e2', from: 'b', to: 'n', kind: 'link' },
      { id: 'e3', from: 'c', to: 'n', kind: 'opened' },
      { id: 'e4', from: 'n', to: 't', kind: 'link' }
    ]
    expect(linkedAgents(doc(nodes, edges), 'n').map((n) => n.title)).toEqual(['Builder', 'Reviewer'])
  })
})

describe('wording', () => {
  test('the button names one agent, or counts several', () => {
    expect(sendTitle([agent('a', 'Builder')])).toBe('Send this note to Builder')
    expect(sendTitle([agent('a', 'Builder'), agent('b', 'Reviewer')])).toBe('Send this note to Builder and Reviewer')
    expect(sendTitle([agent('a', 'A'), agent('b', 'B'), agent('c', 'C')])).toBe('Send this note to 3 linked agents')
  })

  test('the result says what was sent, what waits, and what was refused, in that order', () => {
    expect(sendSummary([{ title: 'Builder', result: { ok: true, queued: false } }])).toBe('Sent to Builder.')
    expect(
      sendSummary([
        { title: 'Builder', result: { ok: true, queued: true } },
        { title: 'Old', result: { ok: false, reason: 'It has exited. Restart it first.' } },
        { title: 'Reviewer', result: { ok: true, queued: false } }
      ])
    ).toBe('Sent to Reviewer. Queued for Builder, which gets it when it is idle. Old: It has exited. Restart it first.')
  })
})
