import { createElement, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import type { IconName } from '../iconPaths'
import { keyTarget, panelKeyAction, panelStack, type PanelKind } from './panelKeys'

export type { PanelKind }

export interface PanelProps {
  kind: PanelKind
  title: React.ReactNode
  icon?: IconName
  /** One line of purpose or context, after the title. */
  sub?: React.ReactNode
  /** Controls in the header, before the close control. */
  actions?: React.ReactNode
  /** The pinned footer: safe action first, the committing one last. */
  footer?: React.ReactNode
  onClose: () => void
  /** Spoken name of the close control. Its tooltip is always "Close (Esc)". */
  closeLabel?: string
  /** Hooks on the close control. */
  closeAttrs?: Record<string, string>
  /** While true, Esc and the close control do nothing. */
  busy?: boolean
  /** The accessible name, when the title isn't plain words. */
  label?: string
  className?: string
  bodyClassName?: string
  /** Lay out the body yourself: children go straight in, with no padding or scroll. */
  flush?: boolean
  /** A form submits on Ctrl+Enter. */
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void
  /** Where focus starts: the element marked data-autofocus, else the first field (forms, modals) or the panel. */
  initialFocus?: 'auto' | 'panel' | 'none'
  /** Answer Esc even when focus isn't inside the panel. On for modals and views, which cover what's behind them. */
  globalEsc?: boolean
  /** Clicking the dim layer around a modal closes it. Off by default, so typed work isn't lost to a stray click. */
  scrimCloses?: boolean
  /** A modal's layer, for one that must sit over everything (confirmations). */
  layerClassName?: string
  /** Anything else for the root: data-* hooks, an id. */
  attrs?: Record<string, string | number | boolean | undefined>
  children?: React.ReactNode
}

const FIELDS = 'textarea:not(:disabled), input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not(:disabled), select:not(:disabled)'

/** The element focus starts on. */
export function initialTarget(root: HTMLElement, kind: PanelKind, mode: 'auto' | 'panel' | 'none'): HTMLElement | null {
  if (mode === 'none') return null
  const marked = root.querySelector<HTMLElement>('[data-autofocus]')
  if (marked) return marked
  if (mode === 'auto' && (kind === 'form' || kind === 'modal')) {
    const field = root.querySelector<HTMLElement>(FIELDS)
    if (field) return field
  }
  return root
}

/**
 * One panel shell: header (icon, title, context, actions, close), a scrolling body and a pinned footer. Esc closes,
 * focus moves in on open and goes back on close. See docs/plans/ux-shell.md.
 */
export function Panel({
  kind,
  title,
  icon,
  sub,
  actions,
  footer,
  onClose,
  closeLabel = 'Close',
  closeAttrs,
  busy = false,
  label,
  className = '',
  bodyClassName = '',
  flush = false,
  onSubmit,
  initialFocus = 'auto',
  globalEsc,
  scrimCloses = false,
  layerClassName = '',
  attrs,
  children
}: PanelProps): React.JSX.Element {
  const root = useRef<HTMLElement | null>(null)
  const latest = useRef({ onClose, busy })
  latest.current = { onClose, busy }
  const modalish = kind === 'modal' || kind === 'view'
  const answersWindow = globalEsc ?? modalish

  // Focus in on open, back out on close: only when focus would otherwise fall to the page.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const el = root.current
    if (el && !el.contains(document.activeElement)) initialTarget(el, kind, initialFocus)?.focus({ preventScroll: true })
    return () => {
      const now = document.activeElement
      if ((!now || now === document.body) && before?.isConnected) before.focus({ preventScroll: true })
    }
    // Only on open: a re-render mustn't move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The top modal or view answers Esc that reaches the window, as when focus was left on the page.
  useEffect(() => {
    if (!answersWindow) return
    const id = panelStack.push()
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !panelStack.isTop(id)) return
      const target = e.target instanceof Element ? e.target : null
      if (target && root.current?.contains(target)) return
      if (target?.closest('.menu-panel, .shell')) return
      if (panelKeyAction(kind, { key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, target: keyTarget(target) }, { isForm: false, busy: latest.current.busy }) === 'close') {
        e.preventDefault()
        latest.current.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      panelStack.remove(id)
    }
  }, [answersWindow, kind])

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.defaultPrevented) return
    const action = panelKeyAction(kind, { key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey, target: keyTarget(e.target as Element) }, { isForm: !!onSubmit, busy })
    if (action === 'close') {
      e.stopPropagation()
      e.preventDefault()
      onClose()
    } else if (action === 'submit') {
      e.preventDefault()
      ;(e.currentTarget as HTMLFormElement).requestSubmit()
    } else if (e.key === 'Tab' && kind === 'modal') trapTab(e)
  }

  const head = (
    <header className="shell-head">
      <h2 className="shell-title">
        {icon && <Icon name={icon} size={16} />}
        <span className="shell-title-text">{title}</span>
      </h2>
      {sub ? <span className="shell-sub">{sub}</span> : <span className="shell-head-gap" />}
      {actions && <div className="shell-actions">{actions}</div>}
      <button type="button" className="icon-btn shell-close" data-shell="close" aria-label={closeLabel} title="Close (Esc)" disabled={busy} onClick={onClose} {...closeAttrs}>
        <Icon name="close" size={16} />
      </button>
    </header>
  )

  const panel = createElement(
    onSubmit ? 'form' : 'section',
    {
      ref: (el: HTMLElement | null) => {
        root.current = el
      },
      className: `shell shell-${kind} ${className}`.trim(),
      role: 'dialog',
      'aria-modal': modalish ? true : undefined,
      'aria-label': label ?? (typeof title === 'string' ? title : undefined),
      'aria-busy': busy || undefined,
      tabIndex: -1,
      onKeyDown,
      onSubmit,
      ...attrs
    },
    head,
    flush ? children : <div className={`shell-body ${bodyClassName}`.trim()}>{children}</div>,
    footer && <footer className="shell-foot">{footer}</footer>
  )

  if (kind !== 'modal') return panel
  const layer = (
    <div
      className={`shell-layer ${layerClassName}`.trim()}
      onMouseDown={(e) => {
        if (scrimCloses && !busy && e.target === e.currentTarget) onClose()
      }}
    >
      {panel}
    </div>
  )
  // Over the whole stage, wherever in the tree it was opened (a card, a column). Keys still bubble through React.
  const host = typeof document === 'undefined' ? null : document.querySelector('.stage')
  return host ? createPortal(layer, host) : layer
}

/** Tab and Shift+Tab stay inside a modal. */
function trapTab(e: React.KeyboardEvent<HTMLElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}
