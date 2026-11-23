import { useEffect, useRef, useState } from 'react'
import { NO_PROBLEMS, SAVE_RETRY_MS, type AppProblems as Problems, type AppProblemsBridge } from '../shared/appProblems'
import './appProblems.css'

declare global {
  interface Window {
    patchbayProblems?: AppProblemsBridge
  }
}

/** How long "Saved again" stays after a failed save goes through. */
const SAVED_SHOWN_MS = 5_000

/**
 * The app's own problems, in a row between the top bar and the canvas: the canvas can't be saved, or background
 * sessions stopped. The canvas moves down for them rather than having its windows covered. Hide folds one to a single
 * slim line that stays until the problem is gone. They were native dialogs; the save one held up the whole app while it
 * was open. See src/main/appProblems.ts.
 */
export function AppProblems(): React.JSX.Element | null {
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS)
  const [savedAgain, setSavedAgain] = useState(false)
  // Which problems the person has folded away, by when each began: a new one shows in full again.
  const [folded, setFolded] = useState<{ save?: number; host?: number }>({})
  const failing = useRef(false)
  useEffect(() => {
    const bridge = window.patchbayProblems
    if (!bridge) return
    const take = (p: Problems): void => {
      // A save that failed and now went through says so, for a moment.
      if (failing.current && !p.save) setSavedAgain(true)
      if (p.save) setSavedAgain(false)
      failing.current = !!p.save
      setProblems(p)
    }
    const off = bridge.onChange(take)
    void bridge.get().then(take)
    return off
  }, [])
  useEffect(() => {
    if (!savedAgain) return
    const t = setTimeout(() => setSavedAgain(false), SAVED_SHOWN_MS)
    return () => clearTimeout(t)
  }, [savedAgain])

  const { save, hostLost } = problems
  if (!save && !hostLost && !savedAgain) return null
  const saveFolded = !!save && folded.save === save.since
  const hostFolded = !!hostLost && folded.host === hostLost.at
  const bringBack = (): void => void window.patchbayProblems?.bringBackHost()
  return (
    <div className="app-problems">
      {save &&
        (saveFolded ? (
          <div className="app-problem app-problem-bad app-problem-folded" role="status" data-app-problem="save" data-folded>
            <span className="app-problem-dot" aria-hidden="true" />
            <span className="app-problem-line">Not saving · trying again every {SAVE_RETRY_MS / 1000} seconds</span>
            <button type="button" className="app-problem-link" data-app-problem-action="show" onClick={() => setFolded((f) => ({ ...f, save: undefined }))}>
              Details
            </button>
          </div>
        ) : (
          <div className="app-problem app-problem-bad" role="alert" data-app-problem="save">
            <span className="app-problem-dot" aria-hidden="true" />
            <div className="app-problem-text">
              <strong>Can't save your canvas</strong>
              <span>
                Writing to {save.dir} failed: {save.error}. Your changes are kept while Patchbay is open, and it's trying again every {SAVE_RETRY_MS / 1000} seconds.
              </span>
            </div>
            <div className="app-problem-actions">
              <button type="button" className="btn" data-app-problem-action="hide" onClick={() => setFolded((f) => ({ ...f, save: save.since }))}>
                Hide
              </button>
            </div>
          </div>
        ))}
      {!save && savedAgain && (
        <div className="app-problem app-problem-good app-problem-folded" role="status" data-app-problem="saved">
          <span className="app-problem-dot" aria-hidden="true" />
          <span className="app-problem-line">Saved again. Your canvas is on disk, with every change made meanwhile.</span>
        </div>
      )}
      {hostLost &&
        (hostFolded ? (
          <div className="app-problem app-problem-bad app-problem-folded" role="status" data-app-problem="host" data-folded>
            <span className="app-problem-dot" aria-hidden="true" />
            <span className="app-problem-line">Background sessions stopped</span>
            <button type="button" className="app-problem-link" data-app-problem-action="bring-back" disabled={hostLost.bringing} onClick={bringBack}>
              {hostLost.bringing ? 'Bringing them back…' : 'Bring them back'}
            </button>
            <button type="button" className="app-problem-link" data-app-problem-action="dismiss" disabled={hostLost.bringing} onClick={() => void window.patchbayProblems?.dismissHostLost()}>
              Dismiss
            </button>
          </div>
        ) : (
          <div className="app-problem app-problem-bad" role="alert" data-app-problem="host">
            <span className="app-problem-dot" aria-hidden="true" />
            <div className="app-problem-text">
              <strong>Background sessions stopped</strong>
              <span>
                {hostLost.error
                  ? `Couldn't bring them back: ${hostLost.error}`
                  : 'The session host stopped unexpectedly, and its sessions ended with it. Their output is kept: agents resume their conversations, and terminals start again below what they showed.'}
              </span>
            </div>
            <div className="app-problem-actions">
              <button type="button" className="btn btn-solid" data-app-problem-action="bring-back" disabled={hostLost.bringing} onClick={bringBack}>
                {hostLost.bringing ? 'Bringing them back…' : hostLost.error ? 'Try again' : 'Bring them back'}
              </button>
              <button type="button" className="btn" data-app-problem-action="hide" disabled={hostLost.bringing} onClick={() => setFolded((f) => ({ ...f, host: hostLost.at }))}>
                Not now
              </button>
            </div>
          </div>
        ))}
    </div>
  )
}
