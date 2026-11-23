import { expect, test } from 'vitest'
import { noteMarkdown, renderMarkdown } from '../../src/renderer/stickyRender'

test("a note's HTML is what renderMarkdown gives it, with tasks on", () => {
  const text = '## Plan\n- [ ] one\n- [x] two'
  expect(noteMarkdown(text)).toBe(renderMarkdown(text, { tasks: true }))
})

test('the same text again is answered from the cache, and changed text is parsed anew', () => {
  const a = noteMarkdown('**a** note')
  expect(noteMarkdown('**a** note')).toBe(a)
  expect(noteMarkdown('**another** note')).toBe(renderMarkdown('**another** note', { tasks: true }))
})

test('after many other notes, an old text still renders right', () => {
  for (let i = 0; i < 260; i++) noteMarkdown(`note ${i}`)
  expect(noteMarkdown('note 0')).toBe(renderMarkdown('note 0', { tasks: true }))
})
