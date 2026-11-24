import { expect, test } from 'vitest'
import { createWorkLog, stallText } from '../../src/main/workLog'

test('says which marked work started inside a window, in order, counting repeats', () => {
  let now = 1000
  const log = createWorkLog(() => now)
  log.note('before')
  now = 2000
  log.note('session sync (woke from sleep)')
  now = 2100
  log.note('agent usage refresh')
  now = 2200
  log.note('session sync (woke from sleep)')
  now = 5000
  log.note('after')
  expect(log.during(1500, 4000)).toEqual(['session sync (woke from sleep) ×2', 'agent usage refresh'])
  expect(log.during(6000, 7000)).toEqual([])
})

test('keeps only the last minute, and at most a few hundred marks', () => {
  let now = 0
  const log = createWorkLog(() => now)
  log.note('old')
  now = 61_000
  log.note('new')
  expect(log.during(0, 61_000)).toEqual(['new'])
  for (let i = 0; i < 1000; i++) log.note(`job ${i}`)
  expect(log.during(0, 61_000)).toHaveLength(8)
})

test('a stall line names what started during it, or stays as it was when nothing did', () => {
  expect(stallText(3000, ['session sync (woke from sleep)', 'agent usage refresh'])).toBe(
    'The main process was blocked for 3.0 s. Started just before or during it: session sync (woke from sleep), agent usage refresh.'
  )
  expect(stallText(1100, [])).toBe('The main process was blocked for 1.1 s.')
})
