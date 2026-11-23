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

