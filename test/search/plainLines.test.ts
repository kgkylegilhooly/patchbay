import { expect, test } from 'vitest'
import { plainLines, searchSources } from '../../src/core/search/sources'
import type { CanvasDoc, StickyNode } from '../../src/shared/model'

test('takes headings, bullets, numbers, quotes and task boxes off the start of lines', () => {
  expect(plainLines('## Plan\n- Fix login\n  * [ ] Ship the unicode fix\n1. First\n> quoted\n- [x] done')).toBe('Plan\nFix login\nShip the unicode fix\nFirst\nquoted\ndone')
})

test('leaves dashes and hashes inside a line alone', () => {
  expect(plainLines('Plan - Fix login #42')).toBe('Plan - Fix login #42')
  expect(plainLines('#hashtag and -flag')).toBe('#hashtag and -flag')
})

test('a note is indexed without its markdown marks, so its snippet reads as text', () => {
  const note = { id: 'n1', kind: 'sticky', title: 'Note', text: '## Plan\n- Fix login', x: 0, y: 0, width: 1, height: 1, parentId: null } as StickyNode
  const doc = { version: 2, nodes: [note], edges: [], projects: [], closed: [] } as unknown as CanvasDoc
  const spec = searchSources(doc, [], 0).sources.find((s) => s.kind === 'note')
  expect(spec && 'text' in spec ? spec.text : null).toBe('Plan\nFix login')
})
