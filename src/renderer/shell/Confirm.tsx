import { useSyncExternalStore } from 'react'
import { Panel } from './Panel'
import { currentConfirm, settleConfirm, subscribeConfirm, type ConfirmSpec } from './confirmStore'

export interface ConfirmDialogProps extends ConfirmSpec {
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

/**
 * The one confirmation for a destructive action: a question, what happens, Cancel and the verb. Danger starts on
 * Cancel, so Enter is the safe key; Esc, ×, Cancel and a click outside all cancel.
 */
export function ConfirmDialog({
  title,
  message,
  lines,
  verb,
  tone = 'danger',
  cancelLabel = 'Cancel',
  attrs,
  verbAttrs,
  cancelAttrs,
  onConfirm,
  onCancel,
  busy = false
}: ConfirmDialogProps): React.JSX.Element {
  const danger = tone === 'danger'
  return (
    <Panel
      kind="modal"
      title={title}
      icon={danger ? 'trash' : undefined}
      onClose={onCancel}
      busy={busy}
      className={`shell-confirm${danger ? ' shell-confirm-danger' : ''}`}
      layerClassName="shell-layer-confirm"
      scrimCloses
      attrs={{ role: 'alertdialog', ...attrs }}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy} data-autofocus={danger ? '' : undefined} {...cancelAttrs}>
            {cancelLabel}
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-solid'}`} onClick={onConfirm} disabled={busy} data-autofocus={danger ? undefined : ''} {...verbAttrs}>
            {verb}
          </button>
        </>
      }
    >
      {message && <p className="confirm-message">{message}</p>}
      {lines && lines.length > 0 && (
        <ul className="confirm-lines">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Shows whatever askConfirm() is waiting on. Mounted once, in the app. */
export function ConfirmHost(): React.JSX.Element | null {
  const current = useSyncExternalStore(subscribeConfirm, currentConfirm, currentConfirm)
  if (!current) return null
  const { id, spec } = current
  return <ConfirmDialog key={id} {...spec} onConfirm={() => settleConfirm(id, true)} onCancel={() => settleConfirm(id, false)} />
}
