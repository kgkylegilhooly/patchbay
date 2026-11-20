import { Icon } from './icons'
import type { IconName } from './iconPaths'

/** The visible name of a small form, the same words as the menu item that opened it. */
export function PopTitle({ icon, children }: { icon?: IconName; children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="pop-title">
      {icon && <Icon name={icon} size={16} />}
      {children}
    </h3>
  )
}

/** Escape cancels. Ctrl+Enter submits from anywhere in the form, a text box included, as Enter does in a one-line field. */
export function popKeys(onCancel: () => void): (e: React.KeyboardEvent<HTMLFormElement>) => void {
  return (e) => {
    if (e.key === 'Escape') onCancel()
    else if (e.key === 'Enter' && e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      e.currentTarget.requestSubmit()
    }
  }
}

/** Says Ctrl+Enter submits, at the start of the buttons row. */
export function SubmitHint(): React.JSX.Element {
  return (
    <span className="pop-hint" aria-hidden="true">
      Ctrl+Enter
    </span>
  )
}
