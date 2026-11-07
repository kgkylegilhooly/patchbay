import { expect, test } from 'vitest'
import { readFromText } from '../../src/main/usage/pageText'

const PAGE = 'Your org\nSpent today: $87.50 of $150\nUpdated now'

test('it takes the first capture group and parses the amount', () => {
  expect(readFromText(PAGE, 'Spent today: \\$([\\d.]+)', { pattern: 'of \\$([\\d.]+)' })).toEqual({ ok: true, used: 87.5, limit: 150 })
})

test('a fixed limit needs no pattern', () => {
  expect(readFromText(PAGE, 'Spent today: \\$([\\d.]+)', { fixed: 200 })).toEqual({ ok: true, used: 87.5, limit: 200 })
})

test('no limit set says so', () => {
  expect(readFromText(PAGE, 'Spent today: \\$([\\d.]+)', {})).toMatchObject({ ok: false, problem: expect.stringMatching(/limit/i) })
})

test('no pattern set says so', () => {
  expect(readFromText(PAGE, '', { fixed: 1 })).toMatchObject({ ok: false, problem: expect.stringMatching(/pattern/i) })
})

test('an invalid pattern says so', () => {
  expect(readFromText(PAGE, '(', { fixed: 1 })).toMatchObject({ ok: false, problem: expect.stringMatching(/isn't valid/) })
})

test('a pattern with no capture group says so', () => {
  expect(readFromText(PAGE, 'Spent', { fixed: 1 })).toMatchObject({ ok: false, problem: expect.stringMatching(/brackets/) })
})

test('no match says the pattern was not found on the page', () => {
  expect(readFromText(PAGE, 'Budget: (\\d+)', { fixed: 1 })).toMatchObject({ ok: false, problem: expect.stringMatching(/found on the page/) })
})

test('a match that is not an amount says so', () => {
  expect(readFromText(PAGE, 'Your (org)', { fixed: 1 })).toMatchObject({ ok: false, problem: expect.stringMatching(/isn't an amount/) })
})

test('a pattern that would hang gives up rather than freezing the app', () => {
  const started = Date.now()
  const r = readFromText(`${'a'.repeat(40)}b`, '^(a+)+$', { fixed: 1 })
  expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/too long/) })
  expect(Date.now() - started).toBeLessThan(5000)
}, 10000)

test('only the first 200 KB of a page is searched', () => {
  const late = `${'x'.repeat(200 * 1024)} Spent: 5`
  expect(readFromText(late, 'Spent: (\\d+)', { fixed: 1 }).ok).toBe(false)
})
