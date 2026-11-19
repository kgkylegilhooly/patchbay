import { expect, test } from 'vitest'
import { toFlow } from '../../src/renderer/flowMapping'
import { CARD, cardSpots } from '../../src/renderer/subagents/placement'
import { loadHidden, pruneHidden, saveHidden, toggleHidden } from '../../src/renderer/subagents/subagentUi'
import { CARD_CAP, elapsed, FADE_MS, LINGER_MS, tokenLabel, visibleCards, type SubagentCard } from '../../src/shared/subagents'
import type { CanvasDoc } from '../../src/shared/model'

const NOW = 1_000_000
const card = (id: string, extra: Partial<SubagentCard> = {}): SubagentCard => ({
  id, parentId: 'n1', agentType: 'Explore', description: id, status: 'running', startedAt: NOW - 5000, tools: 0, depth: 1, ...extra
})

test('finished cards linger, fade over the last seconds, then go', () => {
  const done = (endedAgo: number): SubagentCard => card('d', { status: 'done', endedAt: NOW - endedAgo })
  expect(visibleCards([done(1000)], NOW).shown).toEqual([{ card: done(1000), fading: false }])
  expect(visibleCards([done(LINGER_MS - FADE_MS + 1)], NOW).shown[0].fading).toBe(true)
  expect(visibleCards([done(LINGER_MS)], NOW).shown).toEqual([])
  // A running card never fades or goes.
  expect(visibleCards([card('r', { startedAt: NOW - 3600_000 })], NOW).shown[0].fading).toBe(false)
})

test('a runaway fan-out shows eight slots, the last one "+N more", running agents first', () => {
  const many = [
    ...Array.from({ length: 4 }, (_, i) => card(`done${i}`, { status: 'done', startedAt: NOW - 9000 + i, endedAt: NOW - 100 })),
    ...Array.from({ length: 12 }, (_, i) => card(`run${i}`, { startedAt: NOW - 5000 + i }))
  ]
  const { shown, more } = visibleCards(many, NOW)
  expect(shown).toHaveLength(CARD_CAP - 1)
  expect(more).toBe(16 - (CARD_CAP - 1))
  expect(shown.every((s) => s.card.status === 'running')).toBe(true)
  // Exactly eight fit without a "+N more".
  const eight = visibleCards(many.slice(0, 8), NOW)
  expect(eight.shown).toHaveLength(8)
  expect(eight.more).toBe(0)
})

test('labels: elapsed time, and tokens marked as an estimate while running', () => {
  expect(elapsed(12_400)).toBe('12s')
  expect(elapsed(185_000)).toBe('3m 05s')
  expect(elapsed(3_720_000)).toBe('1h 02m')
  expect(tokenLabel(card('a'))).toBeNull()
  expect(tokenLabel(card('a', { tokens: 88_543 }))).toBe('~88.5k tokens')
  expect(tokenLabel(card('a', { tokens: 188_543, status: 'done' }))).toBe('189k tokens')
  expect(tokenLabel(card('a', { tokens: 640, status: 'failed' }))).toBe('640 tokens')
})

test('the Eye button hides a window’s cards and shows them again, remembered per window', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  let hidden = loadHidden(storage)
  expect(hidden).toEqual({})
  hidden = toggleHidden(hidden, 'n1')
  hidden = toggleHidden(hidden, 'n2')
  saveHidden(hidden, storage)
  expect(loadHidden(storage)).toEqual({ n1: true, n2: true })
  hidden = toggleHidden(loadHidden(storage), 'n1')
  saveHidden(hidden, storage)
  expect(loadHidden(storage)).toEqual({ n2: true })
  // Closed windows drop out of the list.
  expect(pruneHidden({ n1: true, gone: true }, ['n1', 'n3'])).toEqual({ n1: true })
  // Broken or blocked storage hides nothing and throws nothing.
  expect(loadHidden({ getItem: () => '{oops', setItem: () => {} })).toEqual({})
  expect(() => saveHidden({ n1: true }, { getItem: () => null, setItem: () => { throw new Error('full') } })).not.toThrow()
})

test('cards go right of the window, else left, else below, clear of other windows', () => {
  const parent = { x: 0, y: 0, width: 600, height: 400 }
  const right = cardSpots(parent, 3, [])
  expect(right.side).toBe('right')
  expect(right.spots[0].x).toBeGreaterThan(600)
  expect(right.spots[1].y).toBe(right.spots[0].y + CARD.height + 10)
  const blockRight = { x: 640, y: 0, width: 500, height: 420 }
  expect(cardSpots(parent, 3, [blockRight]).side).toBe('left')
  const blockLeft = { x: -600, y: 0, width: 560, height: 900 }
  const below = cardSpots(parent, 3, [blockRight, blockLeft])
  expect(below.side).toBe('below')
  expect(below.spots[0].y).toBeGreaterThan(400)
})

test('cards are never part of the canvas: not in the document, so not in nodes, cables, saves or undo', () => {
  const doc = {
    version: 2,
    projects: [{ id: 'p1', name: 'P', folder: '.', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 0, y: 0, zoom: 1 },
    edges: [],
    closed: [],
    nodes: [{ id: 'n1', kind: 'claude', title: 'A', x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: '.', sessionId: 's', transcriptPath: 't.jsonl', after: [], projectId: 'p1' }]
  } as unknown as CanvasDoc
  const flow = toFlow(doc, { n1: 'working' })
  expect(flow.nodes.map((n) => n.id)).toEqual(['n1'])
  expect(flow.edges).toEqual([])
  // What would be saved has no trace of a subagent.
  expect(JSON.stringify(doc)).not.toMatch(/subagent|sa-card/i)
})
