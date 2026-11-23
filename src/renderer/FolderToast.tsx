import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Icon } from './icons'
import type { Commands } from './menus'
import { shortPath } from './shortPath'

/** A project's folder, just set from the folder chosen for its first agent. See docs/plans/r3-start.md. */
export interface FolderNote {
  projectId: string
  folder: string
  name: string
}

export const useFolderToast = create<{ note: FolderNote | null }>(() => ({ note: null }))

export function showFolderToast(note: FolderNote | null): void {
  useFolderToast.setState({ note })
}

/** The words of the toast. */
export function folderToastText(note: FolderNote): string {
  return `${note.name} now starts in ${shortPath(note.folder)}`
}

const SHOWN_MS = 8000

/**
 * "My project now starts in …\repo" with Change, after an agent's chosen folder became its project's. It goes by
 * itself unless the pointer or focus is on it, as the archive toast does, and uses that toast's look.
 */
export function FolderToast({ commands }: { commands: Commands }): React.JSX.Element | null {
  const note = useFolderToast((s) => s.note)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!note || held) return
    const t = setTimeout(() => showFolderToast(null), SHOWN_MS)
    return () => clearTimeout(t)
  }, [note, held])
  if (!note) return null
  return (
    <div
      className="archived-toast"
      role="status"
      data-folder-toast={note.projectId}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div className="archived-toast-text">
        <p className="archived-toast-head" title={note.folder}>
          {folderToastText(note)}
        </p>
        <p>New agents and terminals here start there.</p>
      </div>
      <button
        type="button"
        className="btn"
        data-folder-toast-change
        onClick={() => {
          commands.chooseProjectFolder(note.projectId)
          showFolderToast(null)
        }}
      >
        Change
      </button>
      <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => showFolderToast(null)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
