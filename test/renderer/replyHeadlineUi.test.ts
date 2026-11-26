import { expect, test } from 'vitest'
import { headlineKey, loadReplyHeadline, rowTitle, useReplyHeadlines } from '../../src/renderer/replyHeadlineUi'

// F57: hovering a sidebar row shows what the agent last said; it's read again only after the agent has done something.
test('a headline is read once per turn: again only when the status or the last activity changed', async () => {
  const reads: string[] = []
  let answer = 'Done: 3 tests pass.'
  const read = async (id: string) => (reads.push(id), answer)
  await loadReplyHeadline('a', headlineKey('idle', 100), read)
  await loadReplyHeadline('a', headlineKey('idle', 100), read)
  expect(reads).toEqual(['a'])
  expect(useReplyHeadlines.getState().a.text).toBe('Done: 3 tests pass.')
  answer = 'Pushed the fix.'
  await loadReplyHeadline('a', headlineKey('idle', 250), read)
  expect(reads).toEqual(['a', 'a'])
  expect(useReplyHeadlines.getState().a.text).toBe('Pushed the fix.')
  await loadReplyHeadline('b', headlineKey('idle', 1), async () => Promise.reject(new Error('no')))
  expect(useReplyHeadlines.getState().b.text).toBeNull()
})

test("the tooltip keeps the folder first, and adds the reply only when there's one", () => {
  expect(rowTitle('C:\\w', 'Pushed the fix.')).toBe('C:\\w\nLast reply: Pushed the fix.')
  expect(rowTitle('C:\\w', null)).toBe('C:\\w')
  expect(rowTitle('', undefined)).toBe('Home folder')
})
