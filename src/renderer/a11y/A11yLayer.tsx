import { useEffect, useMemo, useRef } from 'react'
import type { AriaLabelConfig } from '@xyflow/react'
import { useAgentStops } from '../agentStops'
import { setupHolds } from '../status/setupStatus'
import { useStore } from '../store'
import { alertOf, AnnounceQueue, newAlerts, type Alert } from './announce'
import { keyOf } from './keyHints'
import { useKeyOverrides } from './useKeyOverrides'
import { enterFrame, noteFocusIn } from './regions'
import './a11y.css'

const TERMINAL_HELP_ID = 'pb-terminal-keys'
/** How long after the app opens statuses are still arriving from sessions that were already running. */
const SETTLE_MS = 4000

/** Every window's alert now. Reads the stores when called, so it runs outside React's renders. */
function alertsNow(now: number): Map<string, Alert> {
  const s = useStore.getState()
  const stops = useAgentStops.getState().stops
  const out = new Map<string, Alert>()
  const nodes = s.doc?.nodes ?? []
  const holds = setupHolds(nodes)
  for (const node of nodes) {
    const approval = s.approvals.find((a) => a.nodeId === node.id)
    const alert = alertOf(
      {
        title: node.title,
        status: s.statuses[node.id] ?? null,
        approval: approval ? { requestId: approval.requestId, tool: approval.tool } : undefined,
        stop: stops[node.id],
        setup: holds.get(node.id),
        error: s.errors[node.id]?.message,
        run: node.kind === 'run' ? s.runs[node.id] : undefined
      },
      now
    )
    if (alert) out.set(node.id, alert)
  }
  return out
}

/** What a terminal tells a screen reader about getting out of it, and the words for a window on the canvas. */
function helpWords(f6: string | null, palette: string | null): { terminal: string; node: string } {
  const out = f6 ? `${f6} leaves this window.` : ''
  const find = palette ? `${palette} finds any action.` : ''
  return {
    terminal: [out, find].filter(Boolean).join(' '),
    node: ['Enter types in this window.', f6 ? `${f6} moves to the next part of the app.` : '', find].filter(Boolean).join(' ')
  }
}

/** React Flow's description of a window, which a screen reader reads after its name: how to get in and out by keys. */
export function useCanvasAriaLabels(): Partial<AriaLabelConfig> {
  const overrides = useKeyOverrides()
  return useMemo(() => {
    const words = helpWords(keyOf('next-region', overrides), keyOf('open-palette', overrides))
    return { 'node.a11yDescription.default': words.node, 'node.a11yDescription.keyboardDisabled': words.node }
  }, [overrides])
}

/**
 * The keyboard and screen reader help that has no place of its own: the live region that says when a window needs
 * you, what a terminal says about leaving it, and Enter on a window's frame going into it.
 */
export function A11yLayer(): React.JSX.Element {
  const region = useRef<HTMLDivElement>(null)
  const overrides = useKeyOverrides()
  const words = helpWords(keyOf('next-region', overrides), keyOf('open-palette', overrides))

  // Announcements. The first look is what was already so when the app opened, so it isn't said.
  useEffect(() => {
    const queue = new AnnounceQueue()
    const opened = Date.now()
    let before = alertsNow(opened)
    let check: ReturnType<typeof setTimeout> | undefined
    let flush: ReturnType<typeof setTimeout> | undefined
    let clear: ReturnType<typeof setTimeout> | undefined
    const say = (): void => {
      flush = undefined
      const now = Date.now()
      const text = queue.take(now)
      if (text && region.current) {
        region.current.textContent = text
        clearTimeout(clear)
        // Emptied after a while, so reading the page later doesn't find an old announcement.
        clear = setTimeout(() => region.current && (region.current.textContent = ''), 8000)
      }
      const due = queue.dueAt()
      if (due !== null) flush = setTimeout(say, Math.max(0, due - Date.now()))
    }
    // Statuses can arrive in bursts, so they're looked at together, a moment later.
    const look = (): void => {
      if (check) return
      check = setTimeout(() => {
        check = undefined
        const now = Date.now()
        const after = alertsNow(now)
        // Statuses still arriving just after launch are what was already so, as the sidebar shows: not news.
        if (now - opened >= SETTLE_MS) queue.push(newAlerts(before, after), now)
        before = after
        if (!flush) say()
      }, 150)
    }
    const offStore = useStore.subscribe((s, prev) => {
      if (s.statuses !== prev.statuses || s.approvals !== prev.approvals || s.errors !== prev.errors || s.runs !== prev.runs || s.doc?.nodes !== prev.doc?.nodes) look()
    })
    const offStops = useAgentStops.subscribe(look)
    return () => {
      offStore()
      offStops()
      clearTimeout(check)
      clearTimeout(flush)
      clearTimeout(clear)
    }
  }, [])

  // A terminal's text box says how to leave it; Enter on a window's frame goes in.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      noteFocusIn(e.target)
      const el = e.target as HTMLElement | null
      if (el?.classList?.contains('xterm-helper-textarea') && !el.hasAttribute('aria-describedby')) el.setAttribute('aria-describedby', TERMINAL_HELP_ID)
    }
    // A rename finished from the keyboard (Enter or Esc in the title field) leaves the keyboard on that window's frame,
    // not on the page, so F2 then Enter keeps you where you were.
    const onRenameKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (!el?.classList?.contains('title-input')) return
      const frame = el.closest<HTMLElement>('.react-flow__node')
      setTimeout(() => {
        const now = document.activeElement
        if ((!now || now === document.body) && frame?.isConnected) frame.focus({ preventScroll: true })
      }, 0)
    }
    // After React Flow's own handler, which selects the window on Enter.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (!el?.classList?.contains('react-flow__node')) return
      if (enterFrame(el)) e.preventDefault()
    }
    document.addEventListener('focusin', onFocusIn)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onRenameKey, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onRenameKey, true)
    }
  }, [])

  return (
    <>
      <div ref={region} className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-announcer />
      <p id={TERMINAL_HELP_ID} className="sr-only">
        {words.terminal}
      </p>
    </>
  )
}
