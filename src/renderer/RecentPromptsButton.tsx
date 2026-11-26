import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { withoutPrompt, withPrompt, type SavedPrompt } from '../shared/savedPrompts'
import { PromptsEntries } from './promptsMenu'
import { bridge } from './bridge'
import { ContextMenu } from './Menu'
import type { Point } from './menus'
import { recentPrompts } from './recentPrompts'
import { useStore } from './store'

const NO_SAVED: SavedPrompt[] = []

export function RecentPromptsButton({ onPick, text = '' }: { onPick: (text: string) => void; text?: string }): React.JSX.Element | null {
  const [recent] = useState(recentPrompts)
  const projectId = useStore((s) => s.doc?.activeProjectId)
  const projects = useStore((s) => s.doc?.projects)
  const saved = projects?.find((p) => p.id === projectId)?.prompts ?? NO_SAVED
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
  const others = (projects ?? []).filter((p) => p.id !== projectId && p.archivedAt === undefined).flatMap((p) => (p.prompts ?? []).map((prompt) => ({ project: p.name, prompt })))
  if (!recent.length && !saved.length && !others.length && !text.trim()) return null
  const set = (prompts: SavedPrompt[]): void => {
    if (projectId) void bridge.dispatch({ op: 'setProjectPrompts', id: projectId, prompts })
  }
  const entries = PromptsEntries({
    saved,
    others,
    recent,
    text,
    onPick,
    save: (t) => set(withPrompt(saved, t, crypto.randomUUID(), Date.now())),
    forget: (id) => set(withoutPrompt(saved, id))
  })
  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-sm"
        data-recent-prompts
        aria-haspopup="menu"
        aria-expanded={open}
        title="A prompt saved for this project, or one you used before"
        onClick={(e) => {
          // Inside the field's label: the click is the button's, not the box's.
          e.preventDefault()
          if (Date.now() - closedAt.current < 300) return
          setOpen(!open)
        }}
      >
        Prompts ▾
      </button>
      {open &&
        at &&
        createPortal(
          <ContextMenu
            at={at}
            anchor="end"
            entries={entries}
            label="Prompts"
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
