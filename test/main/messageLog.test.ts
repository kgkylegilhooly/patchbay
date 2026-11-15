import { expect, test } from 'vitest'
import { createMessageLog } from '../../src/main/messageLog'

test('keeps the newest messages, in order, with long texts cut short', () => {
  const log = createMessageLog()
  for (let i = 0; i < 305; i++) log.add('a', 'b', `m${i}`, i)
  const all = log.all()
  expect(all).toHaveLength(300)
  expect(all[0].text).toBe('m5')
  expect(all.at(-1)).toEqual({ from: 'a', to: 'b', text: 'm304', at: 304 })
  expect(log.add('a', 'b', 'x'.repeat(5000)).text).toHaveLength(2001)
  // What it hands out is a copy, so nothing outside can change the log.
  log.all().length = 0
  expect(log.all()).toHaveLength(300)
})
