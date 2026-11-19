import { describe, expect, it } from 'vitest'
import { MAX_QUOTE, place, quoteOf, sectionLabel } from '../../src/core/reader/anchor'
import {
  addComment,
  editComment,
  formatComments,
  inReadingOrder,
  isComment,
  markSent,
  MAX_COMMENTS,
  removeComment,
  reopenComment,
  resolveComment,
  unsent
} from '../../src/core/reader/comments'
import { outline } from '../../src/core/reader/outline'
import type { ReaderComment } from '../../src/shared/reader'

const V1 = '# Plan\n\nShip it **today**.\n\n## Rollout\n\nMigrate every user at once.\n\n## Risks\n\nNone known.\n'

describe('place', () => {
  const doc = outline(V1)

  it('finds a quote under the headings it was written under', () => {
    expect(place({ section: ['Plan', 'Rollout'], quote: 'every user at once' }, doc)).toEqual({ state: 'anchored', section: 1, moved: false })
  })

  it('matches text selected on the page against the Markdown, whatever the spacing', () => {
    // A selection from the page reads the bold word without its marks, and may join blocks without a space.
    expect(place({ section: ['Plan'], quote: 'Ship it today.' }, doc).state).toBe('anchored')
    expect(place({ section: ['Plan'], quote: 'today.Rollout' }, doc).state).toBe('anchored')
  })

  it('follows a quote whose heading was renamed', () => {
    const edited = outline(V1.replace('## Rollout', '## Release'))
    expect(place({ section: ['Plan', 'Rollout'], quote: 'every user at once' }, edited)).toEqual({ state: 'anchored', section: 1, moved: true })
  })

  it('places a quote that runs across sections where it starts', () => {
    expect(place({ section: ['Plan', 'Rollout'], quote: 'at once. Risks None' }, doc)).toEqual({ state: 'anchored', section: 1, moved: false })
  })

  it('marks a comment outdated when its words are gone', () => {
    const edited = outline(V1.replace('Migrate every user at once.', 'Migrate in batches of 100.'))
    expect(place({ section: ['Plan', 'Rollout'], quote: 'every user at once' }, edited)).toEqual({ state: 'outdated' })
  })

  it('places a comment on an empty block by its headings alone', () => {
    expect(place({ section: ['Plan', 'Risks'], quote: '' }, doc)).toEqual({ state: 'anchored', section: 2, moved: false })
    expect(place({ section: ['Gone'], quote: '' }, doc)).toEqual({ state: 'outdated' })
  })

  it('treats a comment with no anchor as on the whole document', () => {
    expect(place(null, doc)).toEqual({ state: 'document' })
  })

  it('cuts long quotes and collapses their whitespace', () => {
    expect(quoteOf('  a \n b ')).toBe('a b')
    expect(quoteOf('x'.repeat(MAX_QUOTE + 50))).toHaveLength(MAX_QUOTE)
    // Not half of an emoji.
    const q = quoteOf(`${'x'.repeat(MAX_QUOTE - 1)}😀tail`)
    expect(q).toBe('x'.repeat(MAX_QUOTE - 1))
  })

  it('names sections the way the person reads them', () => {
    expect(sectionLabel(['Plan', 'Rollout'])).toBe('Plan > Rollout')
    expect(sectionLabel([])).toBe('the start of the document')
  })
})

describe('comment state', () => {
  const base = addComment([], { id: 'a', anchor: { section: ['Plan'], quote: 'Ship it' }, text: '  Not today.  ', at: 1 })

  it('adds a trimmed open comment, and refuses an empty one', () => {
    expect(base).toEqual([{ id: 'a', anchor: { section: ['Plan'], quote: 'Ship it' }, text: 'Not today.', createdAt: 1, resolved: false }])
    expect(addComment(base, { id: 'b', anchor: null, text: '   ', at: 2 })).toBe(base)
  })

  it('stops at the most a document keeps', () => {
    let list: ReaderComment[] = []
    for (let i = 0; i < MAX_COMMENTS + 3; i++) list = addComment(list, { id: String(i), anchor: null, text: 'x', at: i })
    expect(list).toHaveLength(MAX_COMMENTS)
  })

  it('sends open, unsent comments, and marks them sent', () => {
    const two = addComment(base, { id: 'b', anchor: null, text: 'Add a rollback section.', at: 2 })
    expect(unsent(two).map((c) => c.id)).toEqual(['a', 'b'])
    const sent = markSent(two, ['a'], 'Planner', 50)
    expect(sent[0].sent).toEqual({ at: 50, to: 'Planner' })
    expect(unsent(sent).map((c) => c.id)).toEqual(['b'])
  })

  it('leaves resolved comments out of a send', () => {
    expect(unsent(resolveComment(base, 'a'))).toEqual([])
  })

  it('sends a comment again once it is reopened or edited', () => {
    const sent = markSent(base, ['a'], 'Planner', 50)
    expect(unsent(reopenComment(resolveComment(sent, 'a'), 'a')).map((c) => c.id)).toEqual(['a'])
    expect(unsent(editComment(sent, 'a', 'Not this week.')).map((c) => c.id)).toEqual(['a'])
    // The same words aren't an edit.
    expect(unsent(editComment(sent, 'a', 'Not today.'))).toEqual([])
  })

  it('removes a comment', () => {
    expect(removeComment(base, 'a')).toEqual([])
  })

  it('checks stored comments', () => {
    expect(isComment(base[0])).toBe(true)
    expect(isComment({ ...base[0], sent: { at: 1, to: 'x' } })).toBe(true)
    expect(isComment({ ...base[0], anchor: { section: 'Plan', quote: 'x' } })).toBe(false)
    expect(isComment({ ...base[0], resolved: 'no' })).toBe(false)
    expect(isComment(null)).toBe(false)
  })
})

describe('formatComments', () => {
  const doc = outline(V1)
  const comments: ReaderComment[] = [
    { id: '3', anchor: { section: ['Plan', 'Risks'], quote: 'Gone words' }, text: 'This was about risks.', createdAt: 3, resolved: false },
    { id: '2', anchor: { section: ['Plan', 'Rollout'], quote: 'every user at once' }, text: 'Do this in batches of 100.\nStart with staff.', createdAt: 2, resolved: false },
    { id: '1', anchor: null, text: 'Add a rollback section.', createdAt: 1, resolved: false }
  ]

  it('orders whole-document comments first, then by place, then outdated ones', () => {
    expect(inReadingOrder(comments, doc).map((c) => c.id)).toEqual(['1', '2', '3'])
  })

  it('writes one message with each comment, where it is and what it quotes', () => {
    expect(formatComments({ title: 'Plan', path: 'C:\\work\\plan.md', comments, doc })).toBe(
      [
        'Comments on "Plan" (C:\\work\\plan.md). Please address each one, then say what you changed.',
        '',
        '1. On the whole document:',
        '   Add a rollback section.',
        '2. In "Plan > Rollout", on: "every user at once"',
        '   Do this in batches of 100.',
        '   Start with staff.',
        '3. In "Plan > Risks", on: "Gone words" (this text is no longer in the file)',
        '   This was about risks.'
      ].join('\n')
    )
  })

  it('names the section a moved quote is in now', () => {
    const edited = outline(V1.replace('## Rollout', '## Release'))
    const text = formatComments({ title: 'Plan', path: 'p.md', comments: [comments[1]], doc: edited })
    expect(text).toContain('In "Plan > Release", on: "every user at once"')
  })

  it('shortens very long quotes', () => {
    const long = { ...comments[1], anchor: { section: ['Plan'], quote: 'y'.repeat(400) } }
    expect(formatComments({ title: 'P', path: 'p.md', comments: [long], doc })).toContain(`"${'y'.repeat(300)}…"`)
  })
})
