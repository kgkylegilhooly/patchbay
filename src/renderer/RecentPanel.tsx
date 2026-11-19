import { useState } from 'react'
import type { ClosedSession } from '../shared/model'
import { bridge } from './bridge'
import { TranscriptViewer } from './TranscriptViewer'
import { useStore } from './store'
import { useAgentOff } from './agentChoice'

const NONE: ClosedSession[] = []
const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function Entry({ entry, onView }: { entry: ClosedSession; onView: (e: ClosedSession) => void }): React.JSX.Element {
  const off = useAgentOff()(entry.agent)
  return (
    <li className="recent-entry">
      <div className="recent-title">{entry.title}</div>
      <div className="recent-where" title={entry.cwd}>
        {entry.cwd}
      </div>
      <time className="recent-when" dateTime={new Date(entry.closedAt).toISOString()}>
        Closed {TIME.format(entry.closedAt)}
      </time>
      <div className="recent-actions">
        <button className="btn" disabled={!!off} title={off ?? undefined} onClick={() => void bridge.reopenClosed(entry.id)}>
          Reopen
        </button>
        <button className="btn" onClick={() => onView(entry)}>
          View transcript
        </button>
      </div>
    </li>
  )
}

export function RecentPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const allClosed = useStore((s) => s.doc?.closed ?? NONE)
  const activeProjectId = useStore((s) => s.doc?.activeProjectId)
  const projects = useStore((s) => s.doc?.projects)
  // A conversation whose project was closed stays reachable from every project.
  const closed = allClosed.filter((c) => !c.projectId || c.projectId === activeProjectId || !projects?.some((p) => p.id === c.projectId))
  const [viewing, setViewing] = useState<{ entry: ClosedSession; text: string | null; missing: string | null } | null>(null)

  const view = async (entry: ClosedSession): Promise<void> => {
    setViewing({ entry, text: null, missing: null })
    const r = await bridge.readClosedTranscript(entry.id)
    setViewing({ entry, text: r.ok ? r.text : null, missing: r.ok ? null : r.reason })
  }

  return (
    <>
      <aside className="drawer" aria-label="Recent conversations">
        <header className="drawer-head">
          <h2>Recent conversations</h2>
          <button className="icon-btn" aria-label="Close recent conversations" onClick={onClose}>
            ×
          </button>
        </header>
        {closed.length === 0 ? (
          <p className="drawer-empty">Close a Claude node and its conversation appears here, ready to reopen.</p>
        ) : (
          <ul className="recent-list">
            {[...closed].reverse().map((entry) => (
              <Entry key={entry.id} entry={entry} onView={(e) => void view(e)} />
            ))}
          </ul>
        )}
      </aside>
      {viewing && (
        <TranscriptViewer
          title={viewing.entry.title}
          label={`Transcript of ${viewing.entry.title}`}
          text={viewing.text}
          missing={viewing.missing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}
