import { expect, test } from 'vitest'
import { createQuietGate, inQuietHours, minutesOf, quietSummary } from '../../src/main/quietHours'

const at = (h: number, m = 0) => new Date(2026, 10, 25, h, m)

test('quiet hours run from the first time up to the second, also past midnight; blank or equal times mean none', () => {
  expect(minutesOf('07:30')).toBe(450)
  expect(minutesOf('24:00')).toBeNull()
  expect(minutesOf('7pm')).toBeNull()
  // Overnight.
  expect(inQuietHours('22:00', '07:00', at(23, 30))).toBe(true)
  expect(inQuietHours('22:00', '07:00', at(6, 59))).toBe(true)
  expect(inQuietHours('22:00', '07:00', at(7, 0))).toBe(false)
  expect(inQuietHours('22:00', '07:00', at(12))).toBe(false)
  // Within a day.
  expect(inQuietHours('12:00', '13:00', at(12, 30))).toBe(true)
  expect(inQuietHours('12:00', '13:00', at(13, 0))).toBe(false)
  // Off.
  expect(inQuietHours('', '07:00', at(3))).toBe(false)
  expect(inQuietHours('08:00', '08:00', at(8))).toBe(false)
  expect(inQuietHours(undefined, undefined, at(3))).toBe(false)
})

test('held notifications come back once, as one summary naming each window by its latest word, when it is quiet no longer', () => {
  let clock = at(23)
  const gate = createQuietGate({ hours: () => ({ from: '22:00', to: '07:00' }), now: () => clock })
  expect(gate.hold({ title: 'Parser tests', body: 'Finished its turn.' })).toBe(true)
  expect(gate.hold({ title: 'Docs', body: 'Needs you.' })).toBe(true)
  expect(gate.hold({ title: 'Parser tests', body: 'Needs you.' })).toBe(true)
  expect(gate.ended()).toBeNull()
  clock = at(7, 1)
  expect(gate.hold({ title: 'Late', body: 'Needs you.' })).toBe(false)
  expect(gate.ended()).toEqual({ title: 'While it was quiet: 3 notifications held', body: 'Parser tests: Needs you. Docs: Needs you.' })
  expect(gate.ended()).toBeNull()
})

test('a long night names four windows and counts the rest', () => {
  const held = ['A', 'B', 'C', 'D', 'E', 'F'].map((title) => ({ title, body: 'Needs you.' }))
  expect(quietSummary(held)?.body).toBe('A: Needs you. B: Needs you. C: Needs you. D: Needs you. And 2 more.')
  expect(quietSummary([])).toBeNull()
})

test('quiet hours are kept in settings.json, and clearing them removes them', async () => {
  const { mergeSettings, parseSettings } = await import('../../src/main/lifecycle')
  const saved = mergeSettings('{"sound":"off"}', { sound: 'off', quietFrom: '22:00', quietTo: '07:00' })!
  expect(parseSettings(saved)).toMatchObject({ sound: 'off', quietFrom: '22:00', quietTo: '07:00' })
  expect(parseSettings(mergeSettings(saved, { sound: 'off' }))).toEqual({ sound: 'off' })
})
