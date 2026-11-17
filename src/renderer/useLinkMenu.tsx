import { useState } from 'react'
import { createPortal } from 'react-dom'
import { bridge } from './bridge'
import { copyText } from './clipboard'
import { ContextMenu } from './Menu'
import type { Point } from './menus'
import { linkMenu } from './pathMenu'

/**
 * Right-click on a link in rendered text, as in a note or the chat view, for Open link and Copy link. Copy is for a
 * PC whose settings stop a link opening in the browser from another app.
 */
export function useLinkMenu(nodeId: string): { onContextMenu: (e: React.MouseEvent) => void; menu: React.ReactNode; notice: string | null } {
  const [open, setOpen] = useState<{ at: Point; href: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const say = (text: string | null): void => {
    setNotice(text)
    if (text) setTimeout(() => setNotice((n) => (n === text ? null : n)), 2500)
  }
  const onContextMenu = (e: React.MouseEvent): void => {
    const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
    if (!href) return
    // The link's menu instead of the node's own.
    e.preventDefault()
    e.stopPropagation()
    setOpen({ at: { x: e.clientX, y: e.clientY }, href })
  }
  const menu = open
    ? createPortal(
        <ContextMenu
          at={open.at}
          label={open.href}
          onClose={() => setOpen(null)}
          entries={linkMenu({
            open: () => void bridge.openTerminalLink(nodeId, open.href).then((r) => say(r.ok ? null : r.reason)),
            copy: () =>
              void copyText(open.href).then(
                () => say('Link copied.'),
                (e: unknown) => say(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`)
              )
          })}
        />,
        document.body
      )
    : null
  return { onContextMenu, menu, notice }
}
