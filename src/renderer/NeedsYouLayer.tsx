import { useEffect } from 'react'
import { Icon } from './icons'
import { keyFocusOf } from './keys'
import type { Commands } from './menus'
import { closePeek, openPeek, useNeedsYouUi } from './needsYouUi'
import { PeekCard } from './PeekCard'
import './needsYou.css'

/** The peek card, wherever it was opened from, and the "Nothing needs you" note. */
export function NeedsYouLayer({ commands }: { commands: Commands }): React.JSX.Element {
  const peek = useNeedsYouUi((s) => s.peek)
  const notice = useNeedsYouUi((s) => s.notice)

  // Esc on the canvas closes it too. In a terminal Esc stays the terminal's.
  useEffect(() => {
    if (!peek) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || keyFocusOf(e.target as Element | null) !== 'canvas') return
      if (document.querySelector('.menu-panel, .palette, .settings')) return
      e.preventDefault()
      e.stopPropagation()
      closePeek()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [peek])

  return (
    <>
      {peek && <PeekCard key={peek.id} id={peek.id} place={peek} commands={commands} />}
      {notice && (
        <div className="needs-notice" role="status" data-needs-notice>
          {notice}
        </div>
      )}
    </>
  )
}

/** A sidebar row's peek button. The card opens beside the sidebar, level with the row. Pressed again, it closes. */
export function PeekButton({ id, title }: { id: string; title: string }): React.JSX.Element {
  const open = useNeedsYouUi((s) => s.peek?.id === id && s.peek.from === 'sidebar')
  return (
    <button
      type="button"
      className={`peek-btn${open ? ' peek-btn-on' : ''}`}
      data-peek={id}
      aria-label={`Peek at ${title}`}
      aria-expanded={open}
      title="Peek: what it said last, and reply (Space)"
      onClick={(e) => (open ? closePeek() : peekFrom(id, e.currentTarget))}
    >
      <Icon name="find" size={13} />
    </button>
  )
}

/** Opens a sidebar row's peek, placed beside the sidebar. */
export function peekFrom(id: string, el: Element): void {
  const sidebar = el.closest('.sidebar')?.getBoundingClientRect()
  const row = el.closest('li')?.getBoundingClientRect() ?? el.getBoundingClientRect()
  openPeek(id, { from: 'sidebar', x: (sidebar?.right ?? row.right) + 8, y: row.top })
}
