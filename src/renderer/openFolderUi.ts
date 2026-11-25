import type { CanvasNode } from '../shared/model'
import type { MenuItem } from './menus'
import { say } from './reader/readerUi'

declare global {
  interface Window {
    /** See src/preload/folder.ts. */
    patchbayFolder?: { hasVsCode(): Promise<boolean>; open(nodeId: string, how: 'explorer' | 'vscode'): Promise<{ ok: true } | { ok: false; reason: string }> }
  }
}

/** Whether VS Code was found, asked once: menus are built as they open and can't wait. */
let vsCode = false
if (typeof window !== 'undefined') void window.patchbayFolder?.hasVsCode().then((found) => (vsCode = found), () => {})

const open = (nodeId: string, how: 'explorer' | 'vscode'): void =>
  void window.patchbayFolder?.open(nodeId, how).then((r) => {
    if (!r.ok) say(r.reason)
  })

/** A session window's menu rows: its folder in Explorer, and in VS Code when that's installed. */
export function openFolderEntries(node: CanvasNode, hasVsCode = vsCode): MenuItem[] {
  if (!('cwd' in node) || !node.cwd || (node.kind === 'terminal' && node.sshHost)) return []
  return [
    { id: 'open-folder-explorer', label: 'Open folder in Explorer', icon: 'folder-open', run: () => open(node.id, 'explorer') },
    ...(hasVsCode ? [{ id: 'open-folder-vscode', label: 'Open folder in VS Code', icon: 'code-block' as const, run: () => open(node.id, 'vscode') }] : [])
  ]
}
