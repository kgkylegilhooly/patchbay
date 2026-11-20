import { useEffect, useState } from 'react'
import { formatBytes, type ArchivePreview, type ArchiveResult } from '../shared/projects'
import { projectsBridge } from './projectsBridge'
import { archiveLines, plural } from './projectsView'
import { archivedToast } from './archiveToast'
import { showArchived } from './projectsUi'

export function ArchiveDialog({ projectId, onClose }: { projectId: string; onClose: () => void }): React.JSX.Element {
  const [preview, setPreview] = useState<ArchivePreview | null>(null)
  const [clearScrollback, setClearScrollback] = useState(false)
  const [clearSites, setClearSites] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ArchiveResult | null>(null)

  useEffect(() => {
    let live = true
    void projectsBridge.previewArchive(projectId).then((p) => live && setPreview(p))
    return () => {
      live = false
    }
  }, [projectId])

  const archive = async (): Promise<void> => {
    setBusy(true)
    // Only what was shown here: anything that turned up since was never agreed to.
    const shown = preview?.ok ? preview : null
    const result = await projectsBridge.archive(projectId, {
      clearScrollback: clearScrollback && shown ? shown.sessions.map((s) => s.id) : [],
      clearSites: clearSites && shown ? shown.sites.filter((s) => !s.sharedWith.length).map((s) => s.origin) : []
    })
    setBusy(false)
    // Done: a toast says so, with Unarchive, instead of a dialog to dismiss. A refusal stays here to be read.
    if (result.ok && shown) {
      showArchived(archivedToast(projectId, shown.name, result, clearScrollback))
      onClose()
    } else setResult(result)
  }

  const keys = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!busy) onClose()
    }
  }

  if (result) {
    return (
      <div className="pop archive-dialog" role="dialog" aria-label="Project archived" onKeyDown={keys}>
        {result.ok ? (
          <>
            <h2>Archived</h2>
            <ul className="archive-lines">
              <li>{result.stopped ? `Stopped ${plural(result.stopped, 'session')}.` : 'Nothing was running.'}</li>
              {result.stillRunning.length > 0 && (
                <li className="archive-warn">
                  Still running: {result.stillRunning.join(', ')}. Stop {result.stillRunning.length === 1 ? 'it' : 'them'} from the project after unarchiving.
                </li>
              )}
              {clearScrollback && <li>Cleared {formatBytes(result.freedBytes)} of saved terminal output.</li>}
              {result.clearedSites.length > 0 && <li>Cleared storage and cookies for {result.clearedSites.join(', ')}. Sign-ins set for a wider domain may remain.</li>}
              {result.keptSites.length > 0 && <li>Left alone, since another project shows them: {result.keptSites.join(', ')}.</li>}
              {result.problem && <li className="archive-warn">{result.problem}</li>}
            </ul>
          </>
        ) : (
          <p className="archive-warn">{result.reason}</p>
        )}
        <div className="pop-actions">
          <button type="button" className="btn btn-solid" autoFocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    )
  }

  if (!preview)
    return (
      <div className="pop archive-dialog" role="dialog" aria-label="Archive project" aria-busy="true" onKeyDown={keys}>
        <p className="pop-note">Checking what runs in it…</p>
      </div>
    )

  if (!preview.ok) {
    return (
      <div className="pop archive-dialog" role="dialog" aria-label="Archive project" onKeyDown={keys}>
        <h2>Can't archive this project</h2>
        <p className="pop-note">{preview.reason}</p>
        <div className="pop-actions">
          <button type="button" className="btn" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    )
  }

  const clearable = preview.sites.filter((s) => !s.sharedWith.length)
  const shared = preview.sites.filter((s) => s.sharedWith.length)
  return (
    <form
      className="pop archive-dialog"
      role="dialog"
      aria-label={`Archive ${preview.name}`}
      onKeyDown={keys}
      onSubmit={(e) => {
        e.preventDefault()
        if (!busy) void archive()
      }}
    >
      <h2>Archive “{preview.name}”?</h2>
      <ul className="archive-lines">
        {archiveLines(preview).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <label className={`archive-option${preview.scrollbackBytes ? '' : ' archive-option-off'}`}>
        <input type="checkbox" checked={clearScrollback} disabled={!preview.scrollbackBytes} onChange={(e) => setClearScrollback(e.target.checked)} />
        <span>
          Also clear saved terminal output
          <span className="archive-size">{preview.scrollbackBytes ? `frees ${formatBytes(preview.scrollbackBytes)}` : 'none saved'}</span>
        </span>
      </label>
      {preview.sites.length > 0 && (
        <label className={`archive-option${clearable.length ? '' : ' archive-option-off'}`}>
          <input type="checkbox" checked={clearSites} disabled={!clearable.length} onChange={(e) => setClearSites(e.target.checked)} />
          <span>
            Also clear site data for this project's pages
            <span className="archive-size">
              {clearable.length ? `${clearable.map((s) => s.origin).join(', ')}: their cookies and storage, usually a few KB` : 'every site is shared'}
            </span>
            {shared.length > 0 && (
              <span className="archive-size">
                Kept, since another project shows them: {shared.map((s) => `${s.origin} (${s.sharedWith.join(', ')})`).join('; ')}
              </span>
            )}
            <span className="archive-size">The browser cache is shared by all projects and isn't touched here.</span>
          </span>
        </label>
      )}
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-solid" autoFocus disabled={busy}>
          {busy ? 'Archiving…' : 'Archive'}
        </button>
      </div>
    </form>
  )
}
