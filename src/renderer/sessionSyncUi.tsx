import { useEffect, useState } from 'react'
import { JOINED_NOTICE, type SyncReport, type SyncRow } from '../shared/sessionSync'
import { noteJoined, useJoined } from './sessionSync'
import './sessionSync.css'

/**
 * The person's side of keeping the canvas and the background host in agreement: the notice after Restart found a
 * session still running, and the list in Settings > Background sessions. See docs/plans/session-sync.md.
 */

/** On a node whose Restart found its session still running: says so, and offers ending it first, asked twice. */
export function JoinedStrip({ id }: { id: string }): React.JSX.Element | null {
  const joined = useJoined((s) => !!s.joined[id])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!joined) return null
  const end = (): void => {
    setBusy(true)
    void window.patchbaySync
      ?.endAndRestart(id)
      .finally(() => {
        setBusy(false)
        setConfirming(false)
        noteJoined(id, undefined)
      })
  }
  return (
    <div className="strip strip-held" role="status" data-joined>
      <div className="strip-text">
        <span>{confirming ? 'End this session and everything it started, then start it again? An agent resumes its conversation.' : JOINED_NOTICE}</span>
      </div>
      <div className="strip-actions">
        {confirming ? (
          <>
            <button className="btn nodrag" data-joined-action="keep" autoFocus onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button className="btn btn-danger nodrag" data-joined-action="end" disabled={busy} onClick={end}>
              {busy ? 'Ending…' : 'End and restart'}
            </button>
          </>
        ) : (
          <>
            <button className="btn nodrag" data-joined-action="dismiss" onClick={() => noteJoined(id, undefined)}>
              OK
            </button>
            <button className="btn nodrag" data-joined-action="ask" onClick={() => setConfirming(true)}>
              End and restart…
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const NOTES: Record<NonNullable<SyncRow['problem']>, string> = {
  orphan: 'No node shows it.',
  'shown-exited': 'Was shown as ended. Shown again.',
  'pid-gone': 'Its process had gone. Marked as ended.',
  'stale-status': 'Its status had gone quiet. Worked out again.'
}

function shownText(row: SyncRow): string {
  if (!row.title) return '—'
  return row.shown ?? (row.running ? 'running' : 'ended')
}

/** One session with no node: show it as a terminal, or end it, asked twice. Never ended without asking. */
function OrphanActions({ id, onDone }: { id: string; onDone(): void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<void> | undefined): void => {
    setBusy(true)
    void Promise.resolve(fn())
      .catch(() => {})
      .finally(() => {
        setBusy(false)
        setConfirming(false)
        onDone()
      })
  }
  if (confirming) {
    return (
      <span className="sync-actions">
        <button type="button" className="btn" data-sync-action="keep" autoFocus onClick={() => setConfirming(false)}>
          Keep it
        </button>
        <button type="button" className="btn btn-danger" data-sync-action="end" disabled={busy} onClick={() => act(() => window.patchbaySync?.endOrphan(id))}>
          End it
        </button>
      </span>
    )
  }
  return (
    <span className="sync-actions">
      <button type="button" className="btn" data-sync-action="adopt" disabled={busy} onClick={() => act(() => window.patchbaySync?.adoptOrphan(id))}>
        Show it
      </button>
      <button type="button" className="btn" data-sync-action="ask-end" disabled={busy} onClick={() => setConfirming(true)}>
        End…
      </button>
    </span>
  )
}

/** Settings > Background sessions: what the host runs against what the canvas shows, so a mismatch needs no Task Manager. */
export function SessionSyncList(): React.JSX.Element | null {
  const bridge = window.patchbaySync
  const [report, setReport] = useState<SyncReport | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    if (!bridge) return
    void bridge.report().then((r) => r && setReport(r))
    return bridge.onReport(setReport)
  }, [bridge])
  if (!bridge) return null
  const check = (): void => {
    setChecking(true)
    void bridge
      .check()
      .then(setReport)
      .finally(() => setChecking(false))
  }
  const rows = report?.rows ?? []
  const problems = rows.filter((r) => r.problem).length
  const summary = !report
    ? 'Not checked yet.'
    : !report.hostReached
      ? 'There was no background host to ask.'
      : problems === 0
        ? `${rows.length} session${rows.length === 1 ? '' : 's'}, each matching its node.`
        : `${problems} of ${rows.length} didn't match. Patchbay put right what it could; anything with no node waits for you.`

  return (
    <>
      <div className="set-row">
        <div className="set-text">
          <span className="set-title">Sessions and nodes</span>
          <p className="set-help">Checked every minute or so, on reconnecting and on waking. A session the canvas shows as ended but the host still runs is shown again; one with no node is never ended without asking.</p>
        </div>
        <div className="set-control set-input-row">
          <span className="set-value" data-sync-summary>
            {summary}
          </span>
          <button type="button" className="btn" data-sync-action="check" disabled={checking} onClick={check}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="set-row set-row-wide">
          <div className="set-control sync-scroll">
            <table className="sync-table" data-sync-table>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Process</th>
                  <th>Canvas shows</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-sync-row={row.problem ?? 'ok'}>
                    <td>{row.title ?? <span className="sync-none">No node · {row.id.slice(0, 8)}</span>}</td>
                    <td>{row.running ? (row.pid ?? 'starting') : 'ended'}</td>
                    <td>{shownText(row)}</td>
                    <td>
                      {row.problem === 'orphan' ? (
                        <>
                          <span className="sync-note">{NOTES.orphan}</span> <OrphanActions id={row.id} onDone={check} />
                        </>
                      ) : (
                        row.problem && <span className="sync-note">{NOTES[row.problem]}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
