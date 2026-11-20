import { Fragment, useEffect, useState } from 'react'
import { ACTION_SECTIONS, ACTIONS, type Action } from './actions'
import { useStore } from './store'
import { bind, checkBinding, currentKey, keyFromEvent, resetBinding, type KeyProblem, type Overrides } from './keys'

interface Pending {
  id: string
  key: string
  problem: KeyProblem
}

function problemText(p: Pending): string {
  const parts = [
    ...(p.problem.taken.length ? [`${p.key} is already ${p.problem.taken.map((a) => `"${a.label}"`).join(' and ')}, which would lose it.`] : []),
    ...(p.problem.terminalUse ? [`In a terminal, ${p.key} ${p.problem.terminalUse}. It would stop reaching terminals.`] : [])
  ]
  return parts.join(' ')
}

/** Lists every action with its key. Click a key, then press the new one. */
export function ShortcutSettings({ overrides, onChange }: { overrides: Overrides; onChange: (next: Overrides) => void }): React.JSX.Element {
  const [capturing, setCapturing] = useState<string | null>(null)
  /** Why a key was refused, shown under the row it was tried on. */
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    useStore.setState({ capturingKey: !!capturing })
    return () => useStore.setState({ capturingKey: false })
  }, [capturing])

  useEffect(() => {
    if (!capturing) return
    const id = capturing
    const onKey = (e: KeyboardEvent): void => {
      // Taken ahead of everything, so the key being tried doesn't also do what it's bound to now.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return setCapturing(null)
      const key = keyFromEvent(e)
      if (!key) return
      setCapturing(null)
      const problem = checkBinding(id, key, ACTIONS, overrides)
      if (problem.refused) return setRefused({ id, text: problem.refused })
      if (problem.taken.length || problem.terminalUse) return setPending({ id, key, problem })
      onChange(bind(id, key, ACTIONS, overrides))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onChange, overrides])

  const warning = pending && (
    <div className="key-warning" role="alertdialog" aria-label="Use this key?">
      <span>{problemText(pending)}</span>
      <span className="key-warning-actions">
        <button
          type="button"
          className="btn btn-solid"
          data-use-anyway
          onClick={() => {
            onChange(bind(pending.id, pending.key, ACTIONS, overrides))
            setPending(null)
          }}
        >
          Use it anyway
        </button>
        <button type="button" className="btn" onClick={() => setPending(null)}>
          Cancel
        </button>
      </span>
    </div>
  )

  const row = (a: Action): React.JSX.Element => {
    const key = currentKey(a, overrides)
    return (
      <Fragment key={a.id}>
        <div className="key-row" data-action={a.id}>
          <span className="key-label">{a.label}</span>
          {a.fixedKey ? (
            <span className="key-fixed" title="Handled inside the terminal">
              {a.fixedKey} in a terminal
            </span>
          ) : (
            <>
              <button
                type="button"
                className={`key-bind${capturing === a.id ? ' key-bind-on' : ''}`}
                data-bind={a.id}
                aria-label={`Change the shortcut for ${a.label}`}
                onClick={() => {
                  setRefused(null)
                  setPending(null)
                  setCapturing(a.id)
                }}
              >
                {capturing === a.id ? 'Press a key…' : (key ?? <span className="key-none">Add shortcut</span>)}
              </button>
              <span className="key-reset-slot">
                {a.id in overrides && (
                  <button type="button" className="btn key-reset" data-reset={a.id} onClick={() => onChange(resetBinding(a.id, overrides))}>
                    Reset
                  </button>
                )}
              </span>
            </>
          )}
        </div>
        {refused?.id === a.id && (
          <p className="field-problem key-problem" role="alert">
            {refused.text}
          </p>
        )}
        {pending?.id === a.id && warning}
      </Fragment>
    )
  }

  return (
    <>
      <div className="set-group key-notes">
        <p className="set-help">
          With a terminal in use, it gets ordinary keys, including Ctrl combinations. Patchbay takes only keys with Ctrl+Shift or Alt, function keys, Ctrl+K, Ctrl+Comma, and any key you choose here.
        </p>
        <button type="button" className="btn" data-reset-all disabled={Object.keys(overrides).length === 0} onClick={() => onChange({})}>
          Reset all
        </button>
      </div>
      {ACTION_SECTIONS.map((section) => (
        <section className="set-group" key={section} aria-label={section}>
          <h4 className="key-section">{section}</h4>
          {ACTIONS.filter((a) => a.section === section).map(row)}
        </section>
      ))}
    </>
  )
}
