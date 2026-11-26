import { beforeEach, expect, test, vi } from 'vitest'
import { noteTriggersPaused, toggleTriggersPaused, useTriggersPaused } from '../../src/renderer/triggersPaused'
import { withTriggersPaused } from '../../src/main/lifecycle'

beforeEach(() => useTriggersPaused.setState({ paused: false }))

test('the switch follows settings as read, and flips through its own save', async () => {
  noteTriggersPaused({ triggersPaused: 'on' })
  expect(useTriggersPaused.getState().paused).toBe(true)
  const save = vi.fn(async () => ({ ok: true as const }))
  const say = vi.fn()
  await toggleTriggersPaused(save, say)
  expect(save).toHaveBeenCalledWith(false)
  expect(useTriggersPaused.getState().paused).toBe(false)
  await toggleTriggersPaused(save, say)
  expect(save).toHaveBeenLastCalledWith(true)
  expect(useTriggersPaused.getState().paused).toBe(true)
  expect(say.mock.calls.at(-1)?.[0]).toMatch(/^All triggers are paused\./)
})

test("a refused save leaves the switch as it was and says why", async () => {
  const say = vi.fn()
  await toggleTriggersPaused(async () => ({ ok: false, reason: 'settings.json has a mistake in it' }), say)
  expect(useTriggersPaused.getState().paused).toBe(false)
  expect(say).toHaveBeenCalledWith('settings.json has a mistake in it', false)
})

test('saving it keeps every other setting, unknown ones too, and refuses a broken file', () => {
  const text = JSON.stringify({ notifications: 'off', claudeCommand: 'claude', somethingNewer: 1 })
  const on = JSON.parse(withTriggersPaused(text, true) as string)
  expect(on).toEqual({ notifications: 'off', claudeCommand: 'claude', somethingNewer: 1, triggersPaused: 'on' })
  expect(JSON.parse(withTriggersPaused(JSON.stringify(on), false) as string)).toEqual({ notifications: 'off', claudeCommand: 'claude', somethingNewer: 1 })
  expect(JSON.parse(withTriggersPaused(null, true) as string)).toEqual({ triggersPaused: 'on' })
  expect(withTriggersPaused('{ broken', true)).toBeNull()
})
