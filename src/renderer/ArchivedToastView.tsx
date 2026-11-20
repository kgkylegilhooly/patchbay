import { useEffect, useState } from 'react'
import { Icon } from './icons'
import type { Commands } from './menus'
import { unarchiveProject } from './projectActions'
import { showArchived, useProjectsUi } from './projectsUi'

const SHOWN_MS = 10_000

/**
 * "Archived Website. Stopped 2 sessions." with an Unarchive button, after the archive dialog closes. It goes by itself
 * after a while unless the pointer or focus is on it, or it carries a warning, which stays until it's closed.
 */
export function ArchivedToastView({ commands }: { commands: Commands }): React.JSX.Element | null {
  const toast = useProjectsUi((s) => s.archived)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!toast || held || toast.warnings.length) return
    const t = setTimeout(() => showArchived(null), SHOWN_MS)
    return () => clearTimeout(t)
  }, [toast, held])
  if (!toast) return null
  return (
    <div
      className="archived-toast"
      role="status"
      data-archived-toast={toast.projectId}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="archived-toast-text">
        <p className="archived-toast-head">{toast.headline}</p>
        {toast.details.map((d) => (
          <p key={d}>{d}</p>
        ))}
        {toast.warnings.map((w) => (
          <p key={w} className="archive-warn">
            {w}
          </p>
        ))}
      </div>
      <button
        type="button"
        className="btn"
        title="Brings it back to the tabs. Its sessions stay stopped."
        onClick={() => {
          unarchiveProject(toast.projectId)
          commands.reopenProject(toast.projectId)
          showArchived(null)
        }}
      >
        Unarchive
      </button>
      <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => showArchived(null)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
