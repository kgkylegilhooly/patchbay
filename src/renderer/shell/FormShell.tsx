import { useState } from 'react'
import type { IconName } from '../iconPaths'
import { Panel } from './Panel'

export interface FormShellProps {
  /** The same words as the menu item that opened it: "New Claude Code". */
  title: string
  icon?: IconName
  onCancel: () => void
  onSubmit: () => void
  /** The primary button: "Start Claude Code", "Create trigger". */
  submitLabel: React.ReactNode
  /** The primary can't be used yet. */
  blocked?: boolean
  /** Why, in a few words, shown while blocked in place of the Ctrl+Enter hint and said louder when Ctrl+Enter is tried. */
  blockedWhy?: string | null
  /** Ctrl+Enter or Enter while blocked: a way past the block, as a New form's folder picker. Instead of the louder why. */
  onBlockedSubmit?: () => void
  /** What Ctrl+Enter does while blocked, as the why's tooltip. */
  blockedKeyHint?: string
  /** Working: the buttons wait and Esc does nothing. */
  busy?: boolean
  /** Show "Ctrl+Enter" by the buttons. On by default; a one-field form where Enter already submits can turn it off. */
  hint?: boolean
  /** Extra footer controls, before Cancel (a secondary action such as "Run once now"). */
  extraActions?: React.ReactNode
  /** Instead of the usual Cancel + primary pair. */
  footer?: React.ReactNode
  className?: string
  /** Hooks on the primary button. */
  submitAttrs?: Record<string, string>
  attrs?: Record<string, string | number | boolean | undefined>
  children: React.ReactNode
}

/**
 * Every "make something" flow: a title, focus on the first field you type in, Ctrl+Enter to submit, Esc to cancel,
 * and a pinned footer with Cancel and one primary verb.
 */
export function FormShell({
  title,
  icon,
  onCancel,
  onSubmit,
  submitLabel,
  blocked = false,
  blockedWhy,
  onBlockedSubmit,
  blockedKeyHint,
  busy = false,
  hint = true,
  extraActions,
  footer,
  className = '',
  submitAttrs,
  attrs,
  children
}: FormShellProps): React.JSX.Element {
  const [asked, setAsked] = useState(false)
  const why = blocked && blockedWhy ? blockedWhy : null
  return (
    <Panel
      kind="form"
      title={title}
      icon={icon}
      onClose={onCancel}
      busy={busy}
      className={`pop ${className}`.trim()}
      attrs={attrs}
      onSubmit={(e) => {
        e.preventDefault()
        if (blocked && !busy && onBlockedSubmit) return onBlockedSubmit()
        if (blocked && why) setAsked(true)
        if (blocked || busy) return
        onSubmit()
      }}
      footer={
        footer ?? (
          <>
            {why ? (
              <span className={`shell-foot-hint shell-blocked-why${asked ? ' shell-blocked-why-asked' : ''}`} data-blocked-why title={blockedKeyHint} role={asked ? 'alert' : undefined}>
                {why}
              </span>
            ) : hint && (
              <span className="shell-foot-hint" aria-hidden="true">
                Ctrl+Enter
              </span>
            )}
            {extraActions}
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-solid" disabled={blocked || busy} {...submitAttrs}>
              {submitLabel}
            </button>
          </>
        )
      }
    >
      {children}
    </Panel>
  )
}
