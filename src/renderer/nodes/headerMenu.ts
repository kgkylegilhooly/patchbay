import { create } from 'zustand'
import type { MenuEntry } from '../menus'

/**
 * A session window's ⋯ menu: the header tools used now and then, so the header itself keeps only Find, Maximize, ⋯
 * and Close. Built here as plain entries, so what it offers can be tested without a window.
 */

export interface HeaderMenuState {
  kind: 'terminal' | 'claude' | 'run'
  /** Showing a Claude window as a chat rather than its terminal. */
  chat: boolean
  /** Name with AI is running. */
  naming: boolean
  /** The window's text size, the global one, and whether the window has its own. */
  size: number
  global: number
  own: boolean
  min: number
  max: number
  /** Where the session runs, for Copy folder path. Empty: not offered. */
  folder: string
}

export interface HeaderMenuActions {
  refresh: () => void
  toggleChat: () => void
  name: () => void
  step: (by: number) => void
  resetSize: () => void
  copyFolder: () => void
}

export function headerMenuEntries(s: HeaderMenuState, act: HeaderMenuActions): MenuEntry[] {
  const nameable = s.kind === 'terminal' || s.kind === 'claude'
  return [
    { id: 'refresh-window', tool: 'refresh', label: 'Refresh the view', icon: 'refresh', run: act.refresh },
    ...(s.kind === 'claude'
      ? [{ id: 'toggle-chat', tool: 'chat', label: s.chat ? 'Show the terminal' : 'Show as a chat', icon: s.chat ? ('terminal' as const) : ('note' as const), run: act.toggleChat }]
      : []),
    ...(nameable
      ? [{ id: 'name-with-ai', tool: 'name', label: s.naming ? 'Asking Claude for a name…' : 'Name with AI', icon: 'sparkle' as const, disabled: s.naming, run: act.name }]
      : []),
    'separator',
    {
      id: 'font-size',
      tool: 'font-size',
      label: 'Text size',
      icon: 'text-size',
      run: act.resetSize,
      steps: {
        value: String(s.size),
        canRun: s.own,
        runTool: 'font-reset',
        runLabel: s.own ? `Size ${s.size} in this window. Back to the global size, ${s.global}` : `Size ${s.size}, from the global setting`,
        down: { label: 'Smaller text in this window', tool: 'font-smaller', disabled: s.size <= s.min, run: () => act.step(-1) },
        up: { label: 'Larger text in this window', tool: 'font-larger', disabled: s.size >= s.max, run: () => act.step(1) }
      }
    },
    ...(s.folder ? (['separator', { id: 'copy-folder-path', tool: 'copy-path', label: 'Copy folder path', icon: 'copy', run: act.copyFolder }] as MenuEntry[]) : [])
  ]
}

/** Which window's ⋯ menu is open, so Shift+F10 on a focused node can open it from outside the header. */
export const useHeaderMenu = create<{ open: string | null }>(() => ({ open: null }))

export function openHeaderMenu(nodeId: string): void {
  useHeaderMenu.setState({ open: nodeId })
}
