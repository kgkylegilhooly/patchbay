import { create } from 'zustand'

/**
 * Something outside the menus asking for Settings open at one section, as a node that couldn't start does with
 * "Open Settings › Agents". The canvas opens Settings when one is asked for, and Settings takes the section once.
 */
export type SettingsSection = 'claude' | 'sessions'

export const useSettingsAsk = create<{ section: SettingsSection | null }>(() => ({ section: null }))

export function openSettingsAt(section: SettingsSection): void {
  useSettingsAsk.setState({ section })
}

/** The section asked for, cleared, so the next plain open starts where it always does. */
export function takeSettingsSection(): SettingsSection | null {
  const { section } = useSettingsAsk.getState()
  if (section) useSettingsAsk.setState({ section: null })
  return section
}
