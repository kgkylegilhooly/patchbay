import { create } from 'zustand'
import type { CanvasNode, ReaderNode } from '../../shared/model'
import type { MenuEntry, MenuItem, Point } from '../menus'
import { docsBridge } from './readerBridge'

/**
 * Menus load this module, and tests load menus where there's no window, so nothing here touches the window until
 * it's used: the app's bridge and the clipboard are looked up then.
 */
const appBridge = () => window.patchbay
const copy = async (text: string): Promise<void> => (await import('../clipboard')).copyText(text)

/** A line from a reader action that has no window of its own to say it in, such as a menu's. */
export const useReaderUi = create<{ notice: { text: string; ok: boolean } | null }>(() => ({ notice: null }))

export function say(text: string | null, ok = false): void {
  useReaderUi.setState({ notice: text ? { text, ok } : null })
}

/** The latest plan, or long answer, in an agent's conversation, in a reader beside it. */
export async function openPlan(agentId: string): Promise<void> {
  const r = await docsBridge().openPlan(agentId)
  if (!r.ok) say(r.reason)
  else if (r.what === 'answer') say('There was no plan, so this is its latest long answer.', true)
  else say(null)
}

/** The file picker, then a reader where the menu was opened. */
export async function pickDocument(at?: Point): Promise<void> {
  const r = await docsBridge().pick(at)
  if (!r.ok && !('cancelled' in r)) say(r.reason)
}

export async function openDocument(path: string, o: { at?: Point; fromNodeId?: string } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await docsBridge().open({ path, ...o })
  return r.ok ? { ok: true } : r
}

/** For the canvas menu and palette. */
export function openDocumentEntry(at?: Point): MenuItem {
  return { id: 'open-document', label: 'Open document…', icon: 'note', run: () => void pickDocument(at) }
}

/** For an agent's menu. */
export function openPlanEntry(node: CanvasNode): MenuItem[] {
  return node.kind === 'claude' ? [{ id: 'open-plan', label: 'Open plan in Reader', icon: 'note', run: () => void openPlan(node.id) }] : []
}

/** A reader's own menu. */
export function readerMenu(node: ReaderNode, c: { rename: () => void; close: MenuItem }): MenuEntry[] {
  return [
    { id: 'reader-reveal', label: 'Show in File Explorer', icon: 'folder-open', run: () => void appBridge().revealTerminalPath(node.id, node.path).then((r) => say(r.ok ? null : r.reason)) },
    {
      id: 'reader-copy-path',
      label: 'Copy path',
      icon: 'copy',
      run: () => void copy(node.path).then(() => say('Path copied.', true), (e: unknown) => say(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`))
    },
    { id: 'rename', label: 'Rename', icon: 'edit', run: c.rename },
    'separator',
    c.close
  ]
}
