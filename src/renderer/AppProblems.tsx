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
 * The app's own problems, at the top of the canvas: the canvas can't be saved, or background sessions stopped. They
 * were native dialogs; the save one held up the whole app while it was open. See src/main/appProblems.ts.
 */
export function AppProblems(): React.JSX.Element | null {
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS)
  const [savedAgain, setSavedAgain] = useState(false)
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
  return (
    <div className="app-problems">
      {save && (
        <div className="app-problem app-problem-bad" role="alert" data-app-problem="save">
          <div className="app-problem-text">
            <strong>Can't save your canvas</strong>
            <span>
              Writing to {save.dir} failed: {save.error}. Your changes are kept while Patchbay is open, and it's trying again every {SAVE_RETRY_MS / 1000} seconds.
            </span>
          </div>
        </div>
      )}
      {!save && savedAgain && (
        <div className="app-problem app-problem-good" role="status" data-app-problem="saved">
          <div className="app-problem-text">
            <strong>Saved again</strong>
            <span>Your canvas is on disk, with every change made meanwhile.</span>
          </div>
        </div>
      )}
      {hostLost && (
        <div className="app-problem app-problem-bad" role="alert" data-app-problem="host">
          <div className="app-problem-text">
            <strong>Background sessions stopped</strong>
            <span>
              {hostLost.error
                ? `Couldn't bring them back: ${hostLost.error}`
                : 'The session host stopped unexpectedly, and its sessions ended with it. Their output is kept: agents resume their conversations, and terminals start again below what they showed.'}
            </span>
          </div>
          <div className="app-problem-actions">
            <button type="button" className="btn btn-solid" data-app-problem-action="bring-back" disabled={hostLost.bringing} onClick={() => void window.patchbayProblems?.bringBackHost()}>
              {hostLost.bringing ? 'Bringing them back…' : hostLost.error ? 'Try again' : 'Bring them back'}
            </button>
            <button type="button" className="btn" data-app-problem-action="dismiss" disabled={hostLost.bringing} onClick={() => void window.patchbayProblems?.dismissHostLost()}>
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
