import { expect, test } from 'vitest'
import type { AgentStop } from '../../src/shared/agentStop'
import { runMapColor, statusMapColor, TONE_FALLBACK, type ToneColors } from '../../src/renderer/minimapColors'

const t: ToneColors = { working: 'W', done: 'D', needs: 'N', pending: 'P', unknown: 'U', held: 'H', waits: 'A', ended: 'E', none: 'X' }
const now = Date.parse('2026-11-20T12:00:00')
const stop = (patch: Partial<AgentStop>): AgentStop => ({ kind: 'error', at: now, until: null, message: null, holds: null, ...patch })

test('each status takes the colour of its tone, the same one its mark uses', () => {
  expect(statusMapColor('working', undefined, t)).toBe('W')
  expect(statusMapColor('idle', undefined, t)).toBe('D')
  expect(statusMapColor('needs-you', undefined, t)).toBe('N')
  expect(statusMapColor('queued', undefined, t)).toBe('P')
  expect(statusMapColor('starting', undefined, t)).toBe('P')
  expect(statusMapColor('exited', undefined, t)).toBe('E')
})

test('an agent stopped on something only the person can clear, such as a failed login, is held (red), not grey', () => {
  expect(statusMapColor('unknown', stop({ kind: 'auth', holds: 'person' }), t, now)).toBe('H')
  expect(statusMapColor('unknown', stop({ kind: 'error' }), t, now)).toBe('H')
})

test('one at a usage limit that resets by itself waits (amber), until the reset has passed', () => {
  const limit = stop({ kind: 'usage-limit', holds: 'reset', until: now + 3600_000 })
  expect(statusMapColor('unknown', limit, t, now)).toBe('A')
  expect(statusMapColor('unknown', limit, t, now + 2 * 3600_000)).toBe('H')
})

test('a stop only counts while the status is still the unknown it left', () => {
  expect(statusMapColor('working', stop({ holds: 'person' }), t, now)).toBe('W')
})

test('no status yet, and no status at all (a terminal), are told apart', () => {
  expect(statusMapColor('unknown', undefined, t)).toBe('U')
  expect(statusMapColor(null, undefined, t)).toBe('X')
})

test('without a stylesheet it uses the values status.css sets, and no tone is blue', () => {
  expect(statusMapColor('needs-you', undefined)).toBe('#ff453a')
  // A held stop is a darker red than needs-you, so the most urgent stays the brightest on the map.
  expect(TONE_FALLBACK.held).not.toBe(TONE_FALLBACK.needs)
  expect(TONE_FALLBACK.waits).toBe(TONE_FALLBACK.working)
  for (const colour of Object.values(TONE_FALLBACK)) expect(['#7da7ff', '#2f7bf6', '#3d8bfd']).not.toContain(colour)
})

test('a run command is coloured by its own state, not left grey', () => {
  expect(runMapColor({ running: true, exitCode: null, stoppedByYou: false, at: now }, t)).toBe('W')
  expect(runMapColor({ running: false, exitCode: 3, stoppedByYou: false, at: now }, t)).toBe('H')
  expect(runMapColor(undefined, t)).toBe('X')
})
