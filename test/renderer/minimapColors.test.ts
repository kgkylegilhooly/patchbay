import { expect, test } from 'vitest'
import { LED_FALLBACK, NEUTRAL, statusMapColor } from '../../src/renderer/minimapColors'

const t = { working: 'W', idle: 'I', needs: 'N', waiting: 'Q' }

test('each status takes the colour of its dot, from the same tokens', () => {
  expect(statusMapColor('working', undefined, t)).toBe('W')
  expect(statusMapColor('idle', undefined, t)).toBe('I')
  expect(statusMapColor('needs-you', undefined, t)).toBe('N')
  expect(statusMapColor('queued', undefined, t)).toBe('Q')
  expect(statusMapColor('starting', undefined, t)).toBe('Q')
})

test('an agent stopped on something only the person can clear, such as a failed login, is red, not grey', () => {
  expect(statusMapColor('unknown', { holds: 'person' }, t)).toBe('N')
})

test('one stopped on a usage limit or an error is amber', () => {
  expect(statusMapColor('unknown', { holds: 'reset' }, t)).toBe('W')
  expect(statusMapColor('unknown', { holds: null }, t)).toBe('W')
})

test('a stop only counts while the status is still the unknown it left', () => {
  expect(statusMapColor('working', { holds: 'person' }, t)).toBe('W')
})

test('no status, as for a terminal or an agent not yet heard from, is neutral', () => {
  expect(statusMapColor(null, undefined, t)).toBe(NEUTRAL)
  expect(statusMapColor('unknown', undefined, t)).toBe(NEUTRAL)
})

test('without a stylesheet it uses the values styles.css sets', () => {
  expect(statusMapColor('needs-you', undefined)).toBe(LED_FALLBACK.needs)
})
