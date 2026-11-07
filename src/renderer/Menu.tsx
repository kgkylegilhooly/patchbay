import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { actionById } from './actions'
import { Icon } from './icons'
import { currentKey } from './keys'
import { clampToViewport, type MenuEntry, type MenuItem, type Point } from './menus'
import { useStore } from './store'

/**
 * A menu panel. Pressing on it never moves focus, so a terminal keeps the keyboard and Edit > Copy
 * still knows which terminal it means. Keys are therefore taken at the window while it's open.
 */
export function MenuPanel({
  entries,
  label,
  onClose,
  onStep,
  style,
  panelRef
}: {
  entries: MenuEntry[]
  label: string
  onClose: () => void
  /** Left and right, for moving between the menu bar's menus. */
  onStep?: (direction: -1 | 1) => void
  style?: React.CSSProperties
  panelRef?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const usable = entries.filter((e): e is MenuItem => e !== 'separator' && !e.disabled)
  const overrides = useStore((s) => s.keyOverrides)
  const shortcutOf = (item: MenuItem): string | null => {
    if (item.shortcut) return item.shortcut
    const action = actionById(item.id)
    return action ? currentKey(action, overrides) : null
  }
  const [active, setActive] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const choose = (item: MenuItem): void => {
    if (item.disabled) return
    if (item.confirm && confirming !== item.id) {
      setConfirming(item.id)
      setActive(item.id)
      return
    }
    onClose()
    item.run()
  }

  // Refs let the listener below stay attached for the life of the menu.
  const latest = useRef({ usable, active, choose, onClose, onStep })
  latest.current = { usable, active, choose, onClose, onStep }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const m = latest.current
      const move = (by: number): void => {
        const at = m.usable.findIndex((i) => i.id === m.active)
        const next = at === -1 ? (by > 0 ? 0 : m.usable.length - 1) : (at + by + m.usable.length) % m.usable.length
        setActive(m.usable[next]?.id ?? null)
      }
      const handlers: Record<string, () => void> = {
        Escape: m.onClose,
        ArrowDown: () => move(1),
        ArrowUp: () => move(-1),
        ArrowLeft: () => m.onStep?.(-1),
        ArrowRight: () => m.onStep?.(1),
        Enter: () => {
          const item = m.usable.find((i) => i.id === m.active)
          if (item) m.choose(item)
        }
      }
      const handler = handlers[e.key]
      if (!handler) return
      e.preventDefault()
      e.stopPropagation()
      handler()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div
      ref={panelRef}
      className="menu-panel"
      role="menu"
      aria-label={label}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep-${i}`} className="menu-sep" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            data-cmd={entry.id}
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            className={[
              'menu-item',
              active === entry.id ? 'menu-item-active' : '',
              entry.danger ? 'menu-item-danger' : ''
            ].join(' ')}
            onMouseEnter={() => setActive(entry.id)}
            onClick={() => choose(entry)}
          >
            <span className="menu-check" aria-hidden="true">
              {entry.checked ? '✓' : entry.icon ? <Icon name={entry.icon} size={15} /> : ''}
            </span>
            <span className="menu-label">{confirming === entry.id ? entry.confirm : entry.label}</span>
            {shortcutOf(entry) && <span className="menu-shortcut">{shortcutOf(entry)}</span>}
          </button>
        )
      )}
    </div>
  )
}

/** A floating menu at a point: closes on any press elsewhere, on scroll, or when the window loses focus. */
export function ContextMenu({
  at,
  entries,
  label,
  onClose
}: {
  at: Point
  entries: MenuEntry[]
  label: string
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(at)

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (box) setPosition(clampToViewport(at, box, { width: window.innerWidth, height: window.innerHeight }))
  }, [at])

  useEffect(() => {
    const onPress = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onPress, true)
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onPress, true)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <MenuPanel
      panelRef={ref}
      entries={entries}
      label={label}
      onClose={onClose}
      style={{ position: 'fixed', left: position.x, top: position.y }}
    />
  )
}
