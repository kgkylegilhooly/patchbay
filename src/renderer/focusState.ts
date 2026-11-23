import { isSessionNode } from '../shared/model'
import { addWindow, initialLayout, leaves, prune, type Pane } from './focusLayout'
import { nearestInDirection, type Direction, type NavRect } from './nodeNav'
import { useStore } from './store'
import { focusTerminalWhenReady, terminalActions } from './terminalRegistry'

const KEY = 'patchbay.focus'

/** Saved layouts, one per project, on this PC only. */
function saved(): Record<string, unknown> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return typeof all === 'object' && all ? all : {}
  } catch {
    return {}
  }
}

function save(projectId: string, layout: Pane): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), [projectId]: layout }))
  } catch {
    // A layout isn't worth interrupting anyone over.
  }
}

/** Session windows of the project on screen, in canvas order. */
function sessionsOnScreen(): string[] {
  const doc = useStore.getState().doc
  if (!doc) return []
  return doc.nodes.filter((n) => isSessionNode(n) && (!n.projectId || n.projectId === doc.activeProjectId)).map((n) => n.id)
}

/** Its last layout if there is one, or the chosen windows, or the first few on screen. */
export function enterFocus(chosen: string[] = []): void {
  const s = useStore.getState()
  const doc = s.doc
  if (!doc) return
  const here = new Set(sessionsOnScreen())
  const last = prune(saved()[doc.activeProjectId], (id) => here.has(id))
  const picked = chosen.filter((id) => here.has(id))
  let layout = last ?? initialLayout(picked.length ? picked : [...here].slice(0, 4))
  for (const id of picked) layout = addWindow(layout, id)
  useStore.setState({ focus: layout, maximized: null, boardOpen: false })
  save(doc.activeProjectId, layout)
}

export function leaveFocus(): void {
  useStore.setState({ focus: null })
}

export function toggleFocus(chosen: string[] = []): void {
  if (useStore.getState().focus) leaveFocus()
  else enterFocus(chosen)
}

export function setFocusLayout(layout: Pane): void {
  const doc = useStore.getState().doc
  useStore.setState({ focus: layout })
  if (doc) save(doc.activeProjectId, layout)
}

/** Adds a window to the focus view, opening it if it's off. */
export function showInFocus(nodeId: string): void {
  const s = useStore.getState()
  if (!s.focus) return enterFocus([nodeId])
  setFocusLayout(addWindow(s.focus, nodeId))
}

/** Gives a window the keyboard once its card has moved into its pane, which happens on the next frames. */
export function focusSoon(nodeId: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => focusTerminalWhenReady(nodeId)))
}

/**
 * Going to a window while the focus view covers the canvas: it's put in a pane if it isn't in one, and takes the
 * keyboard. Centering it on the hidden canvas would show nothing.
 */
export function revealInFocus(nodeId: string): void {
  const s = useStore.getState()
  if (!s.focus) return
  if (!leaves(s.focus).some((l) => l.nodeId === nodeId)) setFocusLayout(addWindow(s.focus, nodeId))
  focusSoon(nodeId)
}

/** Where each window in the view is on screen, for moving between panes with the arrow keys. */
export function paneRects(): NavRect[] {
  return [...document.querySelectorAll<HTMLElement>('[data-focus-slot]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { id: el.dataset.focusSlot as string, x: r.left, y: r.top, width: r.width, height: r.height }
  })
}

/** Moves the keyboard to the pane that way, by where the panes are on screen rather than on the canvas. */
export function moveBetweenPanes(fromId: string | null, direction: Direction): void {
  const next = nearestInDirection(paneRects(), fromId, direction)
  if (next) terminalActions(next)?.focus()
}

export function registerSlot(nodeId: string, el: HTMLElement | null): void {
  useStore.setState((s) => {
    if (el ? s.focusSlots[nodeId] === el : !s.focusSlots[nodeId]) return s
    const next = { ...s.focusSlots }
    if (el) next[nodeId] = el
    else delete next[nodeId]
    return { focusSlots: next }
  })
}
