import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { actionById } from './actions'
import { Icon } from './icons'
import { currentKey } from './keys'
import { clampToViewport, type MenuEntry, type MenuItem, type Point } from './menus'
import { useStore } from './store'
import { useAgentChoice } from './agentChoice'
import { commandAllowed } from '../shared/agents'
import { confirmThen } from './shell/confirmStore'
import { confirmWords } from './shell/panelKeys'
import { drillEntries, firstUsable, MENU_BACK } from './menuDrill'
import './polishC.css'

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
  // Settings > Agents: an agent turned off isn't offered, in any menu.
  const agents = useAgentChoice()
  // A row with a submenu opens it in this panel's place; the row back leads out again.
  const [sub, setSub] = useState<MenuItem | null>(null)
  entries = drillEntries(entries, sub, () => undefined).filter((e) => e === 'separator' || commandAllowed(e.id, agents))
  const usable = entries.filter((e): e is MenuItem => e !== 'separator' && !e.disabled)
  const overrides = useStore((s) => s.keyOverrides)
  const shortcutOf = (item: MenuItem): string | null => {
    if (item.shortcut) return item.shortcut
    const action = actionById(item.id)
    return action ? currentKey(action, overrides) : null
  }
  const [active, setActive] = useState<string | null>(null)
  const ownRef = useRef<HTMLDivElement | null>(null)
  /** Set by the arrow keys, so a long menu scrolls to the row they reach, but not to a row under the mouse. */
  const keyed = useRef(false)
  /** Where the pointer was last seen over the panel. After the keyboard, a row only takes over once the pointer moves. */
  const pointer = useRef<{ x: number; y: number } | null>(null)
  // Rows that slide under a still pointer, as when a submenu opens in place, get a hover the browser makes up. It
  // would take the active row from the keyboard, so it counts only if the pointer is somewhere new.
  const hover = (e: React.MouseEvent, id: string): void => {
    const p = { x: e.clientX, y: e.clientY }
    const was = pointer.current
    pointer.current = p
    if (keyed.current && (!was || (was.x === p.x && was.y === p.y))) return
    keyed.current = false
    setActive(id)
  }
  const setPanel = (el: HTMLDivElement | null): void => {
    ownRef.current = el
    if (typeof panelRef === 'function') panelRef(el)
    else if (panelRef) (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el
  }

  useEffect(() => {
    if (keyed.current) ownRef.current?.querySelector('.menu-item-active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const drill = (item: MenuItem | null): void => {
    keyed.current = true
    setActive(item?.submenu ? firstUsable(item.submenu) : (sub?.id ?? null))
    setSub(item)
  }

  const choose = (item: MenuItem): void => {
    if (item.disabled) return
    if (item.id === MENU_BACK) return drill(null)
    if (item.submenu) return drill(item)
    if (item.steps && !item.steps.canRun) return
    if (!item.keepOpen && !item.steps) onClose()
    // One confirmation for every destructive item, in its own dialog rather than a reworded menu row.
    if (item.confirm) void confirmThen({ ...confirmWords(item.label === 'Close' ? 'Close window' : item.label), ...(item.confirmTitle ? { title: item.confirmTitle } : {}), message: item.confirm, tone: item.danger ? 'danger' : 'neutral', attrs: { 'data-confirm': item.id } }, item.run)
    else item.run()
  }

  // Refs let the listener below stay attached for the life of the menu.
  const latest = useRef({ usable, active, choose, onClose, onStep, sub, drill })
  latest.current = { usable, active, choose, onClose, onStep, sub, drill }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const m = latest.current
      const move = (by: number): void => {
        const at = m.usable.findIndex((i) => i.id === m.active)
        const next = at === -1 ? (by > 0 ? 0 : m.usable.length - 1) : (at + by + m.usable.length) % m.usable.length
        keyed.current = true
        setActive(m.usable[next]?.id ?? null)
      }
      const handlers: Record<string, () => void> = {
        Escape: () => (m.sub ? m.drill(null) : m.onClose()),
        ArrowDown: () => move(1),
        ArrowUp: () => move(-1),
        ArrowLeft: () => {
          if (m.sub) return m.drill(null)
          const steps = m.usable.find((i) => i.id === m.active)?.steps
          if (steps) return void (!steps.down.disabled && steps.down.run())
          m.onStep?.(-1)
        },
        ArrowRight: () => {
          const item = m.usable.find((i) => i.id === m.active)
          if (item?.submenu) return m.drill(item)
          const steps = item?.steps
          if (steps) return void (!steps.up.disabled && steps.up.run())
          m.onStep?.(1)
        },
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
      ref={setPanel}
      className="menu-panel"
      role="menu"
      aria-label={sub ? sub.label : label}
      data-submenu={sub ? sub.id : undefined}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={(e) => {
        if (!keyed.current) pointer.current = { x: e.clientX, y: e.clientY }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep-${i}`} className="menu-sep" role="separator" />
        ) : entry.steps ? (
          <StepsRow
            key={entry.id}
            item={entry}
            active={active === entry.id}
            onHover={(e) => hover(e, entry.id)}
          />
        ) : (
          <button
            key={entry.id}
            type="button"
            data-cmd={entry.id}
            data-tool={entry.tool}
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            aria-haspopup={entry.submenu ? 'menu' : undefined}
            disabled={entry.disabled}
            className={[
              'menu-item',
              active === entry.id ? 'menu-item-active' : '',
              entry.danger ? 'menu-item-danger' : ''
            ].join(' ')}
            onMouseEnter={(e) => hover(e, entry.id)}
            onClick={() => choose(entry)}
          >
            <span className="menu-check" aria-hidden="true">
              {entry.checked ? '✓' : entry.icon ? <Icon name={entry.icon} size={15} /> : ''}
            </span>
            <span className="menu-label">{entry.label}</span>
            {shortcutOf(entry) && <span className="menu-shortcut">{shortcutOf(entry)}</span>}
            {entry.submenu && <span className="menu-more" aria-hidden="true"><Icon name="chevron" size={13} /></span>}
          </button>
        )
      )}
    </div>
  )
}

/** A − value + row in a menu, such as a window's text size. The value runs the item, when it can. */
function StepsRow({ item, active, onHover }: { item: MenuItem; active: boolean; onHover: (e: React.MouseEvent) => void }): React.JSX.Element {
  const steps = item.steps!
  const step = (s: (typeof steps)['down'], icon: 'minus' | 'plus'): React.JSX.Element => (
    <button type="button" role="menuitem" className="menu-step" data-tool={s.tool} aria-label={s.label} title={s.label} disabled={s.disabled} onClick={s.run}>
      <Icon name={icon} size={13} />
    </button>
  )
  return (
    <div role="group" aria-label={`${item.label} ${steps.value}`} data-cmd={item.id} data-tool={item.tool} className={`menu-item menu-steps${active ? ' menu-item-active' : ''}`} onMouseEnter={onHover}>
      <span className="menu-check" aria-hidden="true">
        {item.icon ? <Icon name={item.icon} size={15} /> : ''}
      </span>
      <span className="menu-label">{item.label}</span>
      {step(steps.down, 'minus')}
      <button
        type="button"
        role="menuitem"
        className={`menu-step-value${steps.canRun ? ' menu-step-value-own' : ''}`}
        data-tool={steps.runTool}
        aria-label={steps.runLabel ?? steps.value}
        title={steps.runLabel}
        disabled={!steps.canRun}
        onClick={item.run}
      >
        {steps.value}
      </button>
      {step(steps.up, 'plus')}
    </div>
  )
}

/** A floating menu at a point:closes on any press elsewhere, on scroll, or when the window loses focus. */
export function ContextMenu({
  at,
  entries,
  label,
  onClose,
  anchor = 'start'
}: {
  at: Point
  entries: MenuEntry[]
  label: string
  onClose: () => void
  /** 'end': the menu's right edge is at `at`, as under a button at the right of a header. */
  anchor?: 'start' | 'end'
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(at)

  useLayoutEffect(() => {
    const place = (): void => {
      const box = ref.current?.getBoundingClientRect()
      const from = anchor === 'end' && box ? { x: at.x - box.width, y: at.y } : at
      if (box) setPosition(clampToViewport(from, box, { width: window.innerWidth, height: window.innerHeight }))
    }
    place()
    // A submenu opens in the panel's place and can be wider or taller than the menu was: placed again, it stays on screen.
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(place)
    watch.observe(el)
    return () => watch.disconnect()
  }, [at, anchor])

  useEffect(() => {
    const onPress = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // The wheel over the menu scrolls a long one. Anywhere else, it closes the menu.
    window.addEventListener('mousedown', onPress, true)
    window.addEventListener('wheel', onPress, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onPress, true)
      window.removeEventListener('wheel', onPress, true)
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
