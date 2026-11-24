import type { CanvasCopy } from '../shared/canvasHistory'
import type { MenuItem } from './menus'
import { say } from './reader/readerUi'
import { confirmThen } from './shell/confirmStore'

declare global {
  interface Window {
    /** See src/preload/history.ts. */
    patchbayHistory?: { list(): Promise<CanvasCopy[]>; restore(name: string): Promise<{ ok: true } | { ok: false; reason: string }> }
  }
}

let copies: CanvasCopy[] = []

/** Reads the copies again. Menus are built as they open and can't wait, so a menu shows the list as last read. */
export function refreshCanvasCopies(): void {
  if (typeof window === 'undefined') return
  void window.patchbayHistory?.list().then((list) => (copies = list), () => {})
}

const when = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** The copy's row: "Sun 23 Nov · 34 windows, 3 projects". */
export function copyLabel(c: CanvasCopy): string {
  return `${when(c.day)} · ${count(c.windows, 'window')}, ${count(c.projects, 'project')}`
}

/** Asks, then restores: Patchbay restarts with the canvas as it was that day. */
export function askRestore(c: CanvasCopy): void {
  void confirmThen(
    {
      title: `Restore the canvas from ${when(c.day)}?`,
      message: `Patchbay restarts with the canvas as it was then: ${count(c.windows, 'window')} in ${count(c.projects, 'project')}.`,
      lines: [
        'Sessions keep running in the background and are found again if their windows are in that copy.',
        'The canvas as it is now is kept in the canvas-history folder, beside the copies.'
      ],
      verb: 'Restore and restart',
      cancelLabel: 'Keep this canvas',
      tone: 'danger',
      icon: 'recent',
      attrs: { 'data-confirm': 'restore-canvas' }
    },
    async () => {
      const r = await window.patchbayHistory?.restore(c.name)
      if (r && !r.ok) say(r.reason)
    }
  )
}

/** File menu: Restore canvas from, a row per daily copy, newest first. Nothing until there's a copy. */
export function restoreCanvasSubmenu(): MenuItem[] {
  refreshCanvasCopies()
  if (!copies.length) return []
  return [{ id: 'restore-canvas', label: 'Restore canvas from', icon: 'recent', run: () => {}, submenu: copies.map((c): MenuItem => ({ id: `restore-canvas:${c.day}`, label: copyLabel(c), icon: 'recent', run: () => askRestore(c) })) }]
}

refreshCanvasCopies()
