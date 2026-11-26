import { expect, test } from 'vitest'
import { savedFromSettingsPage, withTriggersPaused } from '../../src/main/lifecycle'

// The Settings page holds the whole settings as it read them when it opened, and saves that copy on every change. Pause
// all triggers (F54) is set from the Work menu meanwhile, with its own save, so the page's copy of it is stale.
test("a save from the Settings page keeps Pause all triggers as the Work menu last set it", () => {
  const opened = { notifications: 'off' }
  // The Work menu pauses all triggers while Settings is open.
  const paused = withTriggersPaused(JSON.stringify(opened), true)!
  expect(JSON.parse(paused).triggersPaused).toBe('on')
  // Then the person changes a setting on the page, which sends its copy from before the pause.
  const after = JSON.parse(savedFromSettingsPage(paused, { ...opened, sound: 'off' })!)
  expect(after).toEqual({ notifications: 'off', sound: 'off', triggersPaused: 'on' })
  // And the other way: unpaused from the menu, a page opened while paused doesn't pause them again.
  const unpaused = withTriggersPaused(paused, false)!
  expect(JSON.parse(savedFromSettingsPage(unpaused, { notifications: 'off', triggersPaused: 'on' })!).triggersPaused).toBeUndefined()
  expect(savedFromSettingsPage('{ broken', { sound: 'off' })).toBeNull()
})
