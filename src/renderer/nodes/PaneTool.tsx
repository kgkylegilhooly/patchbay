import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isSessionNode } from '../../shared/model'
import { setFocusLayout } from '../focusState'
import { Icon } from '../icons'
import { ContextMenu } from '../Menu'
import type { Point } from '../menus'
import { paneMenuEntries, panePathOf } from '../paneMenu'
import { useStore } from '../store'

/**
 * In the focus view, a window's header holds its pane's controls: show another window here, split, take the pane out.
 * A second bar above the header cost every pane a row, with a second "close" beside the window's own.
 */
export function PaneTool({ nodeId, title }: { nodeId: string; title: string }): React.JSX.Element | null {
  const focus = useStore((s) => s.focus)
  const doc = useStore((s) => s.doc)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<Point | null>(null)
  /** A press on the button while the menu is open closes it first; the click that follows mustn't open it again. */
  const closedAt = useRef(0)
  useLayoutEffect(() => {
    if (!open) return setAt(null)
    const r = button.current?.getBoundingClientRect()
    setAt(r ? { x: r.right, y: r.bottom + 4 } : null)
  }, [open])
  const path = focus ? panePathOf(focus, nodeId) : null
  if (!focus || !path) return null
  const choices = (doc?.nodes ?? [])
    .filter(isSessionNode)
    .filter((n) => !n.projectId || n.projectId === doc?.activeProjectId)
    .map((n) => ({ id: n.id, title: n.title }))
  const close = (): void => {
    closedAt.current = Date.now()
    setOpen(false)
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn tool-btn nodrag tool-pane"
        data-focus="pane-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Pane: show another window here, split it or take it out of the view`}
        title="Pane: show another window here, split, or take out of the view"
        onClick={() => {
          if (Date.now() - closedAt.current < 300) return
          setOpen(!open)
        }}
      >
        <Icon name="grid" size={15} />
      </button>
      {open && at && createPortal(<ContextMenu at={at} anchor="end" entries={paneMenuEntries(focus, path, nodeId, choices, setFocusLayout)} label={`Pane with ${title}`} onClose={close} />, document.body)}
    </>
  )
}
