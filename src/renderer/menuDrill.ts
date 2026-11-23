import type { MenuEntry, MenuItem } from './menus'

/** The row that leads back out of a submenu. */
export const MENU_BACK = 'menu-back'

/**
 * What a menu panel shows: its own entries, or, once a row with a submenu is opened, a row back named after it, then
 * the submenu. The submenu replaces the menu in place, so it needs no second panel and fits wherever the menu did.
 */
export function drillEntries(entries: MenuEntry[], open: MenuItem | null, back: () => void): MenuEntry[] {
  if (!open?.submenu) return entries
  return [{ id: MENU_BACK, label: open.label, icon: 'arrow-left', run: back }, 'separator', ...open.submenu]
}

/** The row to mark when a submenu opens (its first usable row) or closes (the row that opened it). */
export function firstUsable(entries: MenuEntry[]): string | null {
  for (const e of entries) if (e !== 'separator' && !e.disabled && e.id !== MENU_BACK) return e.id
  return null
}
