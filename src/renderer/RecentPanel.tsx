import { useState } from 'react'
import type { ClosedShell, ClosedSession } from '../shared/model'
import { bridge } from './bridge'
import { TranscriptViewer } from './TranscriptViewer'
import { useStore } from './store'
import { useAgentOff } from './agentChoice'
import { Panel } from './shell/Panel'

const NONE: ClosedSession[] = []
const NO_SHELLS: ClosedShell[] = []
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

/** A closed terminal or run (F48): Reopen brings it back in view, started again, with its saved output above. */
function ShellEntry({ shell }: { shell: ClosedShell }): React.JSX.Element {
  const n = shell.node
  const what = n.kind === 'run' ? n.command : n.sshHost ? `ssh ${n.sshHost}` : n.cwd
  return (
    <li className="recent-entry" data-closed-shell={n.id}>
      <div className="recent-title">{n.title}</div>
      <div className="recent-where" title={n.kind === 'run' ? `${n.command} in ${n.cwd}` : n.cwd}>
        {what}
      </div>
      <time className="recent-when" dateTime={new Date(shell.closedAt).toISOString()}>
        Closed {TIME.format(shell.closedAt)}
      </time>
      <div className="recent-actions">
        <button className="btn" data-cmd="reopen-shell" title="Starts it again here, with its earlier output above" onClick={() => void bridge.reopenShell(n.id)}>
          Reopen
        </button>
        <button className="btn" data-cmd="forget-shell" title="Removes it from this list, with its saved output" onClick={() => void bridge.dispatch({ op: 'forgetClosedShell', id: n.id })}>
          Forget
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
  const allShells = useStore((s) => s.doc?.closedShells ?? NO_SHELLS)
  const shells = allShells.filter((s) => !s.node.projectId || s.node.projectId === activeProjectId || !projects?.some((p) => p.id === s.node.projectId))
  const [viewing, setViewing] = useState<{ entry: ClosedSession; text: string | null; missing: string | null } | null>(null)

  const view = async (entry: ClosedSession): Promise<void> => {
    setViewing({ entry, text: null, missing: null })
    const r = await bridge.readClosedTranscript(entry.id)
    setViewing({ entry, text: r.ok ? r.text : null, missing: r.ok ? null : r.reason })
  }

  return (
    <>
      <Panel kind="drawer" title="Closed conversations" icon="recent" closeLabel="Close recent conversations" onClose={onClose} initialFocus="none" flush>
        <div className="recent-scroll">
          {closed.length === 0 ? (
            <p className="drawer-empty">Close a Claude node and its conversation appears here, ready to reopen.</p>
          ) : (
            <ul className="recent-list">
              {[...closed].reverse().map((entry) => (
                <Entry key={entry.id} entry={entry} onView={(e) => void view(e)} />
              ))}
            </ul>
          )}
          {shells.length > 0 && (
            <>
              <h3 className="recent-heading">Terminals and runs</h3>
              <ul className="recent-list">
                {[...shells].reverse().map((shell) => (
                  <ShellEntry key={shell.node.id} shell={shell} />
                ))}
              </ul>
            </>
          )}
        </div>
      </Panel>
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
