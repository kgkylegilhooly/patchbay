import { isSessionNode } from '../shared/model'
import { addWindow, initialLayout, prune, type Pane } from './focusLayout'
import { useStore } from './store'

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

export function registerSlot(nodeId: string, el: HTMLElement | null): void {
  useStore.setState((s) => {
    if (el ? s.focusSlots[nodeId] === el : !s.focusSlots[nodeId]) return s
    const next = { ...s.focusSlots }
    if (el) next[nodeId] = el
    else delete next[nodeId]
    return { focusSlots: next }
  })
}
