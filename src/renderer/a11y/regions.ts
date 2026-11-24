import { terminalActions } from '../terminalRegistry'

/**
 * F6 moves the keyboard between the parts of the app: menu bar, sessions sidebar, canvas, dock, an open small form, and
 * round again (Shift+F6 goes back). From inside a window, a terminal included, the first F6 steps out to that window's
 * frame, so there's always a way out of a terminal that keeps Tab and Esc for itself. Enter on a frame goes back in.
 *
 * A small form (New Claude Code, a run, ssh, a trigger) is a non-modal dialog: the canvas behind it stays live for the
 * mouse, so it isn't aria-modal, and Tab wraps inside it. F6 is the way between it and the rest of the app, both ways,
 * as for any non-modal dialog. See docs/plans/r4-leftovers.md.
 */
export type Region = 'menubar' | 'sidebar' | 'canvas' | 'dock' | 'form'

export const REGION_ORDER: readonly Region[] = ['menubar', 'sidebar', 'canvas', 'dock', 'form']

export interface Here {
  /** The part of the app the keyboard is in, or null on the page itself. */
  region: Region | null
  /** Inside a window on the canvas (its terminal, a field, a button), not on its frame. */
  inWindow: boolean
}

/** Where F6 (step 1) or Shift+F6 (step -1) goes: the window's own frame, a region, or nowhere when none is there. */
export function nextStop(here: Here, present: readonly Region[], step: 1 | -1): 'frame' | Region | null {
  if (here.inWindow) return 'frame'
  const order = REGION_ORDER.filter((r) => present.includes(r))
  if (!order.length) return null
  const at = here.region ? order.indexOf(here.region) : -1
  if (at === -1) return step === 1 ? order[0] : order[order.length - 1]
  return order[(at + step + order.length) % order.length]
}

// What's on the page.

const ROOTS: Record<Region, string> = {
  menubar: '.app > .bar',
  sidebar: '.stage > .sidebar',
  canvas: '.stage > .react-flow',
  dock: '.stage > .dock',
  form: '.stage > .shell-form'
}

/** Something drawn over the app that keeps the keyboard while it's open. F6 leaves it alone. */
const OVER = '.settings, .palette, .shell-layer, .menu-panel'

const shown = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0

function frameOf(el: Element | null): HTMLElement | null {
  return (el?.closest?.('.react-flow__node') as HTMLElement | null) ?? null
}

export function whereIs(el: Element | null): Here {
  if (!el || el === document.body) return { region: null, inWindow: false }
  const frame = frameOf(el)
  if (frame) return { region: 'canvas', inWindow: frame !== el }
  for (const r of REGION_ORDER) if (el.closest(ROOTS[r])) return { region: r, inWindow: false }
  // The empty canvas card stands in for the canvas, and what covers it (board, focus view, a maximized window) too.
  if (el.closest(`.stage-empty, ${COVERS}`)) return { region: 'canvas', inWindow: false }
  return { region: null, inWindow: false }
}

/**
 * What covers the canvas while it's open: the board, the focus view, a window maximized over it. F6 goes there instead
 * of to frames hidden underneath. Read from the page, so this file needs no store and loads anywhere.
 */
const COVERS = '.shell.board, .shell.focus-view, .stage > .unit-maximized'
const cover = (): HTMLElement | null => [...document.querySelectorAll<HTMLElement>(COVERS)].find(shown) ?? null

function presentRegions(): Region[] {
  return REGION_ORDER.filter((r) => {
    if (r === 'canvas') return !!cover() || shown(document.querySelector('.react-flow__node')) || shown(document.querySelector('.stage-empty'))
    return shown(document.querySelector(ROOTS[r]))
  })
}

/** The window F6 last stepped out of, or was in last, so coming back to the canvas lands there. */
let lastWindow: string | null = null

/** The control last used in an open form, so F6 back into it lands where you were. */
let lastInForm: HTMLElement | null = null

export function noteFocusIn(target: EventTarget | null): void {
  const el = target instanceof Element ? target : null
  if (el instanceof HTMLElement && el.closest(ROOTS.form)) lastInForm = el
  // A window's frame on the canvas, or the focus view pane its card was moved into.
  const frame = el?.closest<HTMLElement>('.react-flow__node, [data-focus-slot]')
  const id = frame?.dataset.id ?? frame?.dataset.focusSlot
  if (id) lastWindow = id
}

const firstFocusable = (root: Element | null, selector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]'): HTMLElement | null =>
  [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].find(shown) ?? null

/** In what covers the canvas: the last window's terminal there, else the first terminal, else its first control. */
function coverTarget(over: HTMLElement): HTMLElement {
  if (over.classList.contains('board')) return over
  const last = lastWindow ? over.querySelector<HTMLElement>(`[data-focus-slot="${CSS.escape(lastWindow)}"] .xterm-helper-textarea`) : null
  return last ?? over.querySelector<HTMLElement>('.xterm-helper-textarea') ?? firstFocusable(over) ?? over
}

function canvasTarget(): HTMLElement | null {
  const over = cover()
  if (over) return coverTarget(over)
  const nodes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].filter(shown)
  const byId = (id: string | null): HTMLElement | undefined => (id ? nodes.find((n) => n.dataset.id === id) : undefined)
  const selected = nodes.find((n) => n.classList.contains('selected') && !n.classList.contains('react-flow__node-group'))
  // Reading order, top to bottom then left to right, with groups last: they're frames around windows.
  const first = [...nodes].sort((a, b) => {
    const ga = a.classList.contains('react-flow__node-group') ? 1 : 0
    const gb = b.classList.contains('react-flow__node-group') ? 1 : 0
    if (ga !== gb) return ga - gb
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return Math.abs(ra.top - rb.top) > 24 ? ra.top - rb.top : ra.left - rb.left
  })[0]
  return byId(lastWindow) ?? selected ?? first ?? firstFocusable(document.querySelector('.stage-empty'))
}

/** Back into a form: the control used last in it, else its first field, else the form itself. */
function formTarget(form: HTMLElement): HTMLElement {
  if (lastInForm?.isConnected && form.contains(lastInForm) && shown(lastInForm)) return lastInForm
  return firstFocusable(form, 'textarea:not(:disabled), input:not(:disabled):not([type=hidden])') ?? firstFocusable(form) ?? form
}

function regionTarget(region: Region): HTMLElement | null {
  if (region === 'canvas') return canvasTarget()
  const root = document.querySelector(ROOTS[region])
  if (region === 'form') return root instanceof HTMLElement ? formTarget(root) : null
  if (region === 'menubar') return firstFocusable(root, '.menubar-item')
  if (region === 'sidebar') return firstFocusable(root, '.session') ?? firstFocusable(root)
  return firstFocusable(root)
}

/** F6 and Shift+F6. Returns where the keyboard went, for tests and scripts. */
export function cycleRegion(step: 1 | -1): 'frame' | Region | null {
  if (typeof document === 'undefined' || document.querySelector(OVER)) return null
  const active = document.activeElement
  const here = whereIs(active)
  const stop = nextStop(here, presentRegions(), step)
  if (stop === 'frame') {
    const frame = frameOf(active)
    if (frame?.dataset.id) lastWindow = frame.dataset.id
    frame?.focus()
    return frame ? 'frame' : null
  }
  if (!stop) return null
  regionTarget(stop)?.focus()
  return stop
}

/** Enter on a window's frame goes into it: its terminal, or the first field it has. */
export function enterFrame(frame: HTMLElement): boolean {
  const id = frame.dataset.id
  if (!id) return false
  const terminal = terminalActions(id)
  if (terminal) {
    terminal.focus()
    return true
  }
  const field = firstFocusable(frame, 'textarea:not(:disabled), input:not(:disabled), [contenteditable="true"]')
  field?.focus()
  return !!field
}
