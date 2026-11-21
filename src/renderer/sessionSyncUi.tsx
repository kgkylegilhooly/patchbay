import { useState } from 'react'
import { JOINED_NOTICE, type SyncRow } from '../shared/sessionSync'
import { noteJoined, useJoined } from './sessionSync'
import { confirmThen } from './shell/confirmStore'
import './sessionSync.css'

/**
 * The person's side of keeping the canvas and the background host in agreement: the notice after Restart found a
 * session still running, and the list in Settings > Background sessions. See docs/plans/session-sync.md.
 */

/** On a node whose session was found still running: says so, and offers ending it first, through the confirm dialog. */
export function JoinedStrip({ id }: { id: string }): React.JSX.Element | null {
  const joined = useJoined((s) => !!s.joined[id])
  const [busy, setBusy] = useState(false)
  if (!joined) return null
  const end = (): Promise<void> => {
    setBusy(true)
    return Promise.resolve(window.patchbaySync?.endAndRestart(id)).finally(() => {
      setBusy(false)
      noteJoined(id, undefined)
    })
  }
  const ask = (): void =>
    void confirmThen(
      {
        title: 'End and restart this session?',
        message: 'It and everything it started end now, then it starts again. An agent resumes its conversation.',
        verb: 'End and restart',
        tone: 'danger',
        cancelLabel: 'Keep it',
        attrs: { 'data-joined-confirm': '' },
        verbAttrs: { 'data-joined-action': 'end' },
        cancelAttrs: { 'data-joined-action': 'keep' }
      },
      end
    )
  return (
    <div className="strip strip-held" role="status" data-joined>
      <div className="strip-text">
        <span>{JOINED_NOTICE}</span>
      </div>
      <div className="strip-actions">
        <button className="btn nodrag" data-joined-action="dismiss" onClick={() => noteJoined(id, undefined)}>
          OK
        </button>
        <button className="btn nodrag" data-joined-action="ask" disabled={busy} onClick={ask}>
          {busy ? 'Ending…' : 'End and restart…'}
        </button>
      </div>
    </div>
  )
}

export const NOTES: Record<NonNullable<SyncRow['problem']>, string> = {
  orphan: 'No node shows it.',
  'shown-exited': 'Was shown as ended. Shown again.',
  'pid-gone': 'Its process had gone. Marked as ended.',
  'stale-status': 'Its status had gone quiet. Worked out again.'
}

/** One session with no node: show it as a terminal, or end it, asked first. Never ended without asking. */
export function OrphanActions({ id, onDone }: { id: string; onDone(): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<void> | undefined): Promise<void> => {
    setBusy(true)
    return Promise.resolve(fn())
      .catch(() => {})
      .finally(() => {
        setBusy(false)
        onDone()
      })
  }
  const askEnd = (): void =>
    void confirmThen(
      {
        title: 'End this session?',
        message: 'No node shows it. It and everything it started end now.',
        verb: 'End session',
        tone: 'danger',
        cancelLabel: 'Keep it',
        attrs: { 'data-sync-confirm': '' },
        verbAttrs: { 'data-sync-action': 'end' },
        cancelAttrs: { 'data-sync-action': 'keep' }
      },
      () => act(() => window.patchbaySync?.endOrphan(id))
    )
  return (
    <span className="sync-actions">
      <button type="button" className="btn" data-sync-action="adopt" disabled={busy} onClick={() => void act(() => window.patchbaySync?.adoptOrphan(id))}>
        Show it
      </button>
      <button type="button" className="btn" data-sync-action="ask-end" disabled={busy} onClick={askEnd}>
        End…
      </button>
    </span>
  )
}

/** Settings > Background sessions lists what the host runs against what the canvas shows, with each session's memory and
 * CPU, in resources/ResourceSection.tsx, which uses the parts above. */
