import { create } from 'zustand'
import type { Settings } from '../shared/settings'
import { say as sayInWindow } from './reader/readerUi'

/** Work menu > Pause all triggers (F54), as last read or set. Main decides; this only shows it. */
export const useTriggersPaused = create<{ paused: boolean }>(() => ({ paused: false }))

/** Called with settings as they're read. */
export const noteTriggersPaused = (s: Settings): void => useTriggersPaused.setState({ paused: s.triggersPaused === 'on' })

/** An armed trigger's Next line while they're all paused. */
export const PAUSED_NEXT = 'Paused, with all triggers. Work menu > Pause all triggers turns them back on.'

/** Flips the switch. Given the saver, so this loads where there's no window, as in tests. Says why when it can't. */
export async function toggleTriggersPaused(save: (on: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>, say: (text: string, ok: boolean) => void): Promise<void> {
  const on = !useTriggersPaused.getState().paused
  const result = await save(on)
  if (!result.ok) return say(result.reason, false)
  useTriggersPaused.setState({ paused: on })
  say(on ? 'All triggers are paused. Due runs are skipped until you turn this off, and Run now still works.' : 'Triggers are running again. Runs missed while paused are not caught up.', true)
}

/** The Work menu's and the palette's: saves through main, and says what changed in the window's notice line. */
export const switchTriggersPaused = (): Promise<void> => toggleTriggersPaused((on) => window.patchbay.setTriggersPaused(on), sayInWindow)
