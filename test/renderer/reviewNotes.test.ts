import { expect, test } from 'vitest'
import { formatReview, noteTarget, parseDiff, type ReviewNote } from '../../src/renderer/reviewNotes'

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -10,3 +10,3 @@ fn', ' keep', '-old', '+new', ' tail', ''].join('\n')

test('parseDiff numbers each line in the file it belongs to, and the headers stay unnumbered', () => {
  const lines = parseDiff(DIFF)
  expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
    ['meta', undefined, undefined],
    ['meta', undefined, undefined],
    ['meta', undefined, undefined],
    ['hunk', undefined, undefined],
    ['context', 10, 10],
    ['del', 11, undefined],
    ['add', undefined, 11],
    ['context', 12, 12]
  ])
})

test('notes go on added, removed and unchanged lines, not headers', () => {
  const lines = parseDiff(DIFF)
  expect(noteTarget(lines[3])).toBeNull()
  expect(noteTarget(lines[5])).toEqual({ line: 11, side: 'old' })
  expect(noteTarget(lines[6])).toEqual({ line: 11, side: 'new' })
})

test('formatReview groups notes by file and says where each one is', () => {
  const notes: ReviewNote[] = [
    { id: '1', path: 'a.ts', line: 11, side: 'new', code: '+new', text: 'Name this better' },
    { id: '2', path: 'b.ts', line: 3, side: 'old', code: '-gone', text: 'Why remove this?\nIt was used.' },
    { id: '3', path: 'a.ts', line: 12, side: 'new', code: ' tail', text: 'Add a test' }
  ]
  expect(formatReview(notes, 'patchbay')).toBe(
    [
      'Review of the changes in patchbay. Please address each note, then say what you changed.',
      '',
      'a.ts:',
      '- line 11: `+new`',
      '  Name this better',
      '- line 12: `tail`',
      '  Add a test',
      '',
      'b.ts:',
      '- removed line 3 (old file): `-gone`',
      '  Why remove this? It was used.'
    ].join('\n')
  )
})
