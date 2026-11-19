import { describe, expect, it } from 'vitest'
import { hiddenBy, normalizeText, outline } from '../../src/core/reader/outline'

const PLAN = [
  'Intro line before any heading.',
  '',
  '# Migration plan',
  '',
  'We move **every** user to the `new` store &amp; keep the old one.',
  '',
  '## Phase 1',
  '',
  '- [ ] Write the copier',
  '- [x] Add a flag',
  '',
  '### Details',
  '',
  '| Step | Owner |',
  '| --- | --- |',
  '| Copy | API team |',
  '',
  '## Phase 2',
  '',
  '```ts',
  'const batch = 100',
  '```',
  '',
  '# Rollback',
  '',
  'Flip the <b>flag</b> back.'
].join('\n')

describe('outline', () => {
  const doc = outline(PLAN)

  it('cuts the document at every heading, keeping the text before the first', () => {
    expect(doc.sections.map((s) => [s.depth, s.title])).toEqual([
      [0, ''],
      [1, 'Migration plan'],
      [2, 'Phase 1'],
      [3, 'Details'],
      [2, 'Phase 2'],
      [1, 'Rollback']
    ])
  })

  it('gives each section the path of headings above it', () => {
    expect(doc.sections[3].path).toEqual(['Migration plan', 'Phase 1', 'Details'])
    expect(doc.sections[4].path).toEqual(['Migration plan', 'Phase 2'])
    expect(doc.sections[5].path).toEqual(['Rollback'])
    expect(doc.sections[0].path).toEqual([])
  })

  it('reads sections as the page shows them, without Markdown marks or entities', () => {
    expect(doc.sections[1].text).toBe('Migration plan We move every user to the new store & keep the old one.')
    expect(doc.sections[2].text).toContain('Write the copier')
    expect(doc.sections[2].text).not.toContain('[ ]')
    expect(doc.sections[3].text).toContain('Copy API team')
    expect(doc.sections[4].text).toContain('const batch = 100')
    expect(doc.sections[5].text).toBe('Rollback Flip the flag back.')
  })

  it('keeps reference link definitions for rendering a section alone', () => {
    const d = outline('# A\n\nSee [the spec][s].\n\n# B\n\n[s]: https://example.com/spec\n')
    expect(d.sections[0].body.links.s?.href).toBe('https://example.com/spec')
  })

  it('has no empty first section when the document starts with a heading', () => {
    expect(outline('# Only\n\ntext').sections.map((s) => s.title)).toEqual(['Only'])
    expect(outline('').sections).toEqual([])
  })

  it('collapses whitespace', () => {
    expect(normalizeText('  a\n\n b\tc ')).toBe('a b c')
  })
})

describe('hiddenBy', () => {
  const depths = [{ depth: 0 }, { depth: 1 }, { depth: 2 }, { depth: 3 }, { depth: 2 }, { depth: 1 }]

  it('hides deeper sections under a collapsed heading, up to the next one at its level', () => {
    expect([...hiddenBy(depths, new Set([2]))]).toEqual([3])
    expect([...hiddenBy(depths, new Set([1]))]).toEqual([2, 3, 4])
  })

  it('keeps hiding when a hidden heading is itself collapsed', () => {
    expect([...hiddenBy(depths, new Set([1, 2]))]).toEqual([2, 3, 4])
  })

  it('never hides from the text before the first heading', () => {
    expect([...hiddenBy(depths, new Set([0]))]).toEqual([])
  })
})
