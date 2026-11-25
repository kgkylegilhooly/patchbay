import { expect, test } from 'vitest'
import { clockTime, heldReason, parseResetTime, RELEASE_MARGIN_MS, stopExplained, stopFromHook, stopHolds, stopLabel } from '../../src/shared/agentStop'

const at = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const NOW = at(2026, 11, 19, 21, 40)

test('a reset time in the message is the next time it names, after the failure', () => {
  expect(parseResetTime("You've hit your 5-hour limit · resets 12:30am", NOW)).toBe(at(2026, 11, 20, 0, 30))
  expect(parseResetTime('Claude usage limit reached. Your limit will reset at 11pm (Europe/London).', NOW)).toBe(at(2026, 11, 19, 23, 0))
  expect(parseResetTime('5-hour limit reached ∙ resets 9pm', NOW)).toBe(at(2026, 11, 20, 21, 0))
  expect(parseResetTime('Weekly limit reached · resets Nov 21, 9am', NOW)).toBe(at(2026, 11, 21, 9, 0))
  expect(parseResetTime('Weekly limit · resets Jan 2 at 3:15pm', NOW)).toBe(at(2027, 1, 2, 15, 15))
  expect(parseResetTime('resets 14:05', NOW)).toBe(at(2026, 11, 20, 14, 5))
  expect(parseResetTime('resets 12pm', NOW)).toBe(at(2026, 11, 20, 12, 0))
})

test('a message naming no time gives none, rather than a guess', () => {
  expect(parseResetTime('API Error: 429 rate limited', NOW)).toBeNull()
  expect(parseResetTime('the counter resets 5 times', NOW)).toBeNull()
  expect(parseResetTime('resets 25:00', NOW)).toBeNull()
  expect(parseResetTime('resets 13pm', NOW)).toBeNull()
})

test('a usage limit takes its reset from the status line window at 100%, else from the message', () => {
  const message = "You've hit your 5-hour limit · resets 12:30am"
  const plan = { fiveHour: { percent: 100, resetsAt: at(2026, 11, 20, 0, 30, ) / 1000 + 17 }, at: NOW }
  expect(stopFromHook({ error: 'rate_limit', last_assistant_message: message }, NOW, plan)).toEqual({
    kind: 'usage-limit',
    at: NOW,
    until: at(2026, 11, 20, 0, 30) + 17_000,
    message,
    holds: 'reset'
  })
  // A window not at its limit, or already reset, says nothing about this stop.
  const stale = { fiveHour: { percent: 100, resetsAt: NOW / 1000 - 60 }, sevenDay: { percent: 40, resetsAt: NOW / 1000 + 86400 }, at: NOW }
  expect(stopFromHook({ error: 'rate_limit', last_assistant_message: message }, NOW, stale).until).toBe(at(2026, 11, 20, 0, 30))
})

test('each error kind says what it holds: limits until their reset, logins for the person, the rest nothing', () => {
  expect(stopFromHook({ error: 'rate_limit' }, NOW)).toMatchObject({ kind: 'rate-limit', until: NOW + 60_000, holds: 'reset', retry: true })
  expect(stopFromHook({ error: 'rate_limit', error_details: 'Too many requests. Resets at 9:50pm' }, NOW)).toMatchObject({ kind: 'usage-limit', until: at(2026, 11, 19, 21, 50), holds: 'reset' })
  expect(stopFromHook({ error: 'authentication_failed' }, NOW)).toMatchObject({ kind: 'auth', holds: 'person' })
  expect(stopFromHook({ error: 'billing_error' }, NOW)).toMatchObject({ kind: 'billing', holds: 'person' })
  expect(stopFromHook({ error: 'server_error' }, NOW)).toMatchObject({ kind: 'server', holds: null })
  expect(stopFromHook({ error: 'max_output_tokens' }, NOW)).toMatchObject({ kind: 'error', holds: null })
  // An older hook script forwards no error field, so the message decides.
  expect(stopFromHook({ last_assistant_message: "You've hit your 5-hour limit · resets 12:30am" }, NOW)).toMatchObject({ kind: 'usage-limit', holds: 'reset' })
  expect(stopFromHook({}, NOW)).toMatchObject({ kind: 'error', message: null, holds: null })
})

test('a limit holds until a moment after its reset, a person-held stop until it moves', () => {
  const stop = stopFromHook({ error: 'rate_limit', last_assistant_message: 'resets 12:30am' }, NOW)
  expect(stopHolds(stop, stop.until! - 1)).toBe(true)
  expect(stopHolds(stop, stop.until! + RELEASE_MARGIN_MS - 1)).toBe(true)
  expect(stopHolds(stop, stop.until! + RELEASE_MARGIN_MS)).toBe(false)
  expect(stopHolds(stopFromHook({ error: 'authentication_failed' }, NOW), NOW + 10 * 86400_000)).toBe(true)
  expect(stopHolds(stopFromHook({ error: 'server_error' }, NOW), NOW)).toBe(false)
})

test('labels say what happened and until when, in local 24-hour time', () => {
  const stop = stopFromHook({ error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 12:30am" }, NOW)
  expect(stopLabel(stop, NOW)).toBe('Usage limit until 00:30')
  expect(stopLabel({ ...stop, willContinue: true }, NOW)).toBe('Usage limit until 00:30 · continues then')
  expect(stopLabel(stop, stop.until! + 1)).toBe('Usage limit reset at 00:30')
  expect(stopLabel(stopFromHook({ error: 'authentication_failed' }, NOW), NOW)).toBe('Login failed')
  expect(clockTime(at(2026, 11, 22, 9, 0), NOW)).toBe('Sun 09:00')
  expect(stopExplained(stop, NOW)).toMatch(/^Usage limit until 00:30\. Messages and trigger prompts for it wait until then and go out by themselves/)
  expect(stopExplained(stop, stop.until! + RELEASE_MARGIN_MS)).toMatch(/back at its prompt/)
  expect(heldReason(stop, NOW)).toBe('Usage limit until 00:30. It goes out then')
  expect(heldReason(stop, stop.until! + RELEASE_MARGIN_MS)).toBeNull()
})

// F25: a stopped agent that a plain "continue" would get going again, and only that.
test('Continue is offered for a server or unknown error at the prompt, not for limits, login or billing', async () => {
  const { canContinue } = await import('../../src/shared/agentStop')
  const stop = (kind: string, holds: 'reset' | 'person' | null) => ({ kind, at: 1, until: null, message: null, holds }) as never
  expect(canContinue(stop('server', null))).toBe(true)
  expect(canContinue(stop('error', null))).toBe(true)
  expect(canContinue(stop('usage-limit', 'reset'))).toBe(false)
  expect(canContinue(stop('rate-limit', 'reset'))).toBe(false)
  expect(canContinue(stop('auth', 'person'))).toBe(false)
  expect(canContinue(stop('billing', 'person'))).toBe(false)
  expect(canContinue(undefined)).toBe(false)
})
