import { expect, test } from 'vitest'
import { createSearchIndex, plainLines } from '../../src/core/search/searchIndex'
import { searchSources } from '../../src/core/search/sources'
import type { CanvasDoc, StickyNode } from '../../src/shared/model'

const note = (text: string): CanvasDoc =>
  ({
    version: 2,
    projects: [{ id: 'p1', name: 'Patchbay', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 0, y: 0, zoom: 1 },
    edges: [],
    closed: [],
    nodes: [{ id: 'n1', kind: 'sticky', title: 'Note', text, x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'p1' } as StickyNode]
  }) as unknown as CanvasDoc

test('takes headings, bullets, list numbers, quotes and task boxes off the start of lines', () => {
  expect(plainLines('## Plan\n- Fix login\n  * [ ] Ship the unicode fix\n1. First\n> quoted\n- [x] done')).toBe('Plan\nFix login\nShip the unicode fix\nFirst\nquoted\ndone')
})

test('leaves dashes and hashes inside a line alone, and long numbers that are not list numbers', () => {
  expect(plainLines('Plan - Fix login #42')).toBe('Plan - Fix login #42')
  expect(plainLines('#hashtag and -flag')).toBe('#hashtag and -flag')
  expect(plainLines('2026. A year')).toBe('2026. A year')
})

test("a note's snippet reads as text, without its markdown marks", async () => {
  const index = createSearchIndex()
  await index.sync(searchSources(note('## Plan\n- Fix login\n- Ship the unicode fix'), [], 0))
  expect(index.search({ text: 'unicode' }).hits[0].snippet).toBe('Plan Fix login Ship the unicode fix')
})

test('the index keeps the marks, so a list number can still be searched for', async () => {
  const index = createSearchIndex()
  await index.sync(searchSources(note('12. Q3 budget\n404) page'), [], 0))
  expect(index.search({ text: '12.' }).hits).toHaveLength(1)
  const hit = index.search({ text: '404' }).hits[0]
  expect(hit.snippet).toContain('404')
  expect(hit.marks.length).toBeGreaterThan(0)
})
