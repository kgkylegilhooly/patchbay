import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenu } from './Menu'
import type { MenuItem, Point } from './menus'
import { promptLabel, recentPrompts } from './recentPrompts'

/** Recent ▾ beside a prompt box: a past prompt, picked, fills it. Nothing shows until there's one to pick. */
export function RecentPromptsButton({ onPick }: { onPick: (text: string) => void }): React.JSX.Element | null {
  const [list] = useState(recentPrompts)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<Point | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  /** A press on the button while the menu is open closes it first; the click that follows mustn't open it again. */
  const closedAt = useRef(0)
  useLayoutEffect(() => {
    if (!open) return setAt(null)
    const r = button.current?.getBoundingClientRect()
    setAt(r ? { x: r.right, y: r.bottom + 4 } : null)
  }, [open])
  if (!list.length) return null
  const entries = list.map((text, i): MenuItem => ({ id: `recent-prompt:${i}`, label: promptLabel(text), run: () => onPick(text) }))
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-sm"
        data-recent-prompts
        aria-haspopup="menu"
        aria-expanded={open}
        title="A prompt you used before"
        onClick={(e) => {
          // Inside the field's label: the click is the button's, not the box's.
          e.preventDefault()
          if (Date.now() - closedAt.current < 300) return
          setOpen(!open)
        }}
      >
        Recent ▾
      </button>
      {open &&
        at &&
        createPortal(
          <ContextMenu
            at={at}
            anchor="end"
            entries={entries}
            label="Recent prompts"
            onClose={() => {
              closedAt.current = Date.now()
              setOpen(false)
            }}
          />,
          document.body
        )}
    </>
  )
}
