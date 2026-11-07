import { ACTIONS } from './actions'
import { sanitizeOverrides, type Overrides } from './keys'
import type { UsageMode } from './usageView'

export type SidebarTab = 'project' | 'status'

export interface Prefs {
  sidebar: boolean
  /** Pinned, the sidebar stays open. Unpinned, it hides when the canvas is clicked. */
  sidebarPinned: boolean
  sidebarTab: SidebarTab
  /** The sidebar sections folded shut, by their ids. */
  collapsed: Record<string, boolean>
  minimap: boolean
  legend: boolean
  snap: boolean
  fontSize: number
  usageMode: UsageMode
  /** Shortcuts changed from their defaults. */
  keys: Overrides
  /** Palette actions, the most recently used first. */
  recentActions: string[]
  terminal: TerminalLook
  /** What the mouse wheel does over empty canvas. */
  wheel: 'zoom' | 'pan'
}

/** How every terminal and agent window draws its text. */
export interface TerminalLook {
  /** Empty means Patchbay's own choice. */
  fontFamily: string
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  copyOnSelect: boolean
  /** Lines kept to scroll back through. */
  scrollback: number
}

export const DEFAULT_FONT_FAMILY = '"Cascadia Mono", Consolas, monospace'
export const SCROLLBACK = { min: 1000, max: 100_000, standard: 10_000 }
export const TERMINAL_DEFAULTS: TerminalLook = { fontFamily: '', cursorStyle: 'block', cursorBlink: false, copyOnSelect: false, scrollback: SCROLLBACK.standard }

/** Settings files are edited by hand at times, so every field is checked. */
export function cleanTerminalLook(v: unknown): TerminalLook {
  const t = (typeof v === 'object' && v !== null ? v : {}) as Partial<Record<keyof TerminalLook, unknown>>
  const n = typeof t.scrollback === 'number' && Number.isFinite(t.scrollback) ? Math.round(t.scrollback) : SCROLLBACK.standard
  return {
    fontFamily: typeof t.fontFamily === 'string' ? t.fontFamily.slice(0, 200) : '',
    cursorStyle: t.cursorStyle === 'bar' || t.cursorStyle === 'underline' ? t.cursorStyle : 'block',
    cursorBlink: t.cursorBlink === true,
    copyOnSelect: t.copyOnSelect === true,
    scrollback: Math.min(SCROLLBACK.max, Math.max(SCROLLBACK.min, n))
  }
}

/** The CSS font list for a chosen font: the choice first, then Patchbay's own as a fallback. */
export function fontStack(family: string): string {
  // Nothing that could close the quotes or end the declaration.
  const name = family.trim().replace(/["\\;{}]/g, '')
  return name ? `"${name}", ${DEFAULT_FONT_FAMILY}` : DEFAULT_FONT_FAMILY
}

export type TogglePref = 'sidebar' | 'minimap' | 'legend' | 'snap'

export const FONT_SIZE = { min: 10, max: 20, standard: 13 }

const KEY = 'patchbay.prefs'
const DEFAULTS: Prefs = {
  sidebar: true,
  sidebarPinned: true,
  sidebarTab: 'project',
  collapsed: {},
  minimap: true,
  legend: false,
  snap: false,
  fontSize: FONT_SIZE.standard,
  usageMode: 'left',
  keys: {},
  recentActions: [],
  terminal: TERMINAL_DEFAULTS,
  wheel: 'zoom'
}

export function loadPrefs(): Prefs {
  try {
    const prefs = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) }
    return {
      ...prefs,
      fontSize: clampFontSize(prefs.fontSize),
      sidebarTab: prefs.sidebarTab === 'status' ? 'status' : 'project',
      collapsed: typeof prefs.collapsed === 'object' && prefs.collapsed ? prefs.collapsed : {},
      keys: sanitizeOverrides(prefs.keys, ACTIONS),
      recentActions: Array.isArray(prefs.recentActions) ? prefs.recentActions.filter((r) => typeof r === 'string') : [],
      terminal: cleanTerminalLook(prefs.terminal),
      wheel: prefs.wheel === 'pan' ? 'pan' : 'zoom'
    }
  } catch {
    return DEFAULTS
  }
}

export function clampFontSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return FONT_SIZE.standard
  return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)))
}

/** What a window draws at: its own size if it has a usable one, or the global setting. */
export function windowFontSize(own: unknown, global: number): number {
  return typeof own === 'number' && Number.isFinite(own) ? clampFontSize(own) : global
}

/** The window's next own size, one step from what it draws at now. */
export function steppedFontSize(own: unknown, global: number, step: number): number {
  return clampFontSize(windowFontSize(own, global) + step)
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // A view preference isn't worth interrupting anyone over.
  }
}
