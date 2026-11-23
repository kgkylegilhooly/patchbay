/** Which panels there are: see docs/plans/ux-shell.md. */
export type PanelKind = 'modal' | 'drawer' | 'view' | 'form'

/** What a key press inside a panel does. */
export type PanelKeyAction = 'close' | 'submit' | null

export interface PanelKey {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  /** Where the key came from. */
  target: {
    /** A text box, a content-editable or a terminal: places where Esc may mean something else, or typed work is lost. */
    textEntry: boolean
    /** Marked `data-own-esc`: a field that uses Esc itself (an inline rename, an open picker). */
    ownsEsc: boolean
  }
}

/**
 * The one rule for keys in a panel.
 * - Esc closes. A field that owns Esc keeps it. In a drawer or a view, which stay open while you work, Esc from a
 *   text box or terminal doesn't throw the panel away; a modal or form closes from anywhere, as it always did.
 * - Ctrl+Enter submits a form from anywhere in it, a text box included.
 */
export function panelKeyAction(kind: PanelKind, e: PanelKey, opts: { isForm: boolean; busy?: boolean }): PanelKeyAction {
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (opts.busy || e.target.ownsEsc) return null
    if ((kind === 'drawer' || kind === 'view') && e.target.textEntry) return null
    return 'close'
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && opts.isForm && !opts.busy) return 'submit'
  return null
}

/**
 * Whether an Esc that reached the window from outside a panel closes it (for the top panel only). A small form answers
 * too, so one left open after a click elsewhere still closes on Esc, but never from a text box or a terminal, where Esc
 * means something else (it interrupts Claude) and typed work would be lost.
 */
export function windowEscCloses(kind: PanelKind, target: PanelKey['target']): boolean {
  return !(kind === 'form' && target.textEntry)
}

/** Tab and Shift+Tab wrap inside modals, views and small forms, so focus never walks out of a form left open. */
export function trapsTab(kind: PanelKind): boolean {
  return kind !== 'drawer'
}

/** Reads the target facts from a DOM element. */
export function keyTarget(el: Element | null): PanelKey['target'] {
  if (!el) return { textEntry: false, ownsEsc: false }
  const tag = el.tagName
  const input = tag === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test((el as HTMLInputElement).type)
  const textEntry = input || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true || !!el.closest?.('.xterm')
  return { textEntry, ownsEsc: !!el.closest?.('[data-own-esc]') }
}

/** The order panels opened in, so only the top one answers a key that reaches the window. */
const stack: number[] = []
let nextId = 1

export const panelStack = {
  push(): number {
    const id = nextId++
    stack.push(id)
    return id
  },
  remove(id: number): void {
    const at = stack.indexOf(id)
    if (at !== -1) stack.splice(at, 1)
  },
  isTop(id: number): boolean {
    return stack[stack.length - 1] === id
  },
  size(): number {
    return stack.length
  }
}

/** "Delete project…" asks "Delete project?" and its button says "Delete project". */
export function confirmWords(label: string): { title: string; verb: string } {
  const verb = label.replace(/(…|\.\.\.)\s*$/, '').trim()
  return { title: `${verb}?`, verb }
}
