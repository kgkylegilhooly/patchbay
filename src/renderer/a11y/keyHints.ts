import { actionById } from '../actions'
import { currentKey, type Overrides } from '../keys'

/** The key an action is bound to now, following any rebinding, or null when it has none. */
export function keyOf(actionId: string, overrides: Overrides): string | null {
  const action = actionById(actionId)
  return action ? currentKey(action, overrides) : null
}

/** A tooltip that teaches the key: "Fit view (Ctrl+Shift+F)". Just the label when the action has no key. */
export function withKey(label: string, actionId: string, overrides: Overrides): string {
  const key = keyOf(actionId, overrides)
  return key ? `${label} (${key})` : label
}


/** What a terminal tells a screen reader about getting out of it, the words for a window on the canvas, and a form's. */
export function helpWords(f6: string | null, palette: string | null): { terminal: string; node: string; form: string } {
  const out = f6 ? `${f6} leaves this window.` : ''
  const find = palette ? `${palette} finds any action.` : ''
  return {
    terminal: [out, find].filter(Boolean).join(' '),
    node: ['Enter types in this window.', f6 ? `${f6} moves to the next part of the app.` : '', find].filter(Boolean).join(' '),
    // A small form is a non-modal dialog: what's behind it still works, and F6 goes there and back.
    form: ['Ctrl+Enter submits. Esc closes.', f6 ? `${f6} moves between this form and the rest of the app.` : ''].filter(Boolean).join(' ')
  }
}
