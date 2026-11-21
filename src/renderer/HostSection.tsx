import { useEffect, useState } from 'react'
import type { HostInfo } from '../shared/contract'
import { bridge } from './bridge'
import { confirmThen } from './shell/confirmStore'

const count = (n: number): string => `${n} session${n === 1 ? '' : 's'}`

function stateLine(info: HostInfo): string {
  switch (info.mode) {
    case 'background':
      return `Running, with ${count(info.running)} in it.`
    case 'starting':
      return 'Starting.'
    case 'stopped':
      return 'Not running. The next session you open starts it.'
    case 'in-process':
      return `Not available. ${count(info.running)} running inside the app.`
    case 'other-version':
      return `Running from another version, with ${count(info.running)} in it.`
  }
}

/**
 * The background session host: whether it's there, what's in it, and the way to end it. What it runs is listed above it,
 * with each session's memory, in resources/ResourceSection.tsx.
 */
export function HostSection({ memory }: { memory?: string } = {}): React.JSX.Element {
  const [info, setInfo] = useState<HostInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void bridge.getHostInfo().then(setInfo)
    return bridge.onHostInfo(setInfo)
  }, [])

  if (!info) return <div className="set-group" />

  const stop = (): void => {
    setBusy(true)
    void bridge.stopHost().finally(() => setBusy(false))
  }
  const askStop = (): void =>
    void confirmThen(
      {
        title: 'Stop the session host?',
        message: `This ends ${count(info.running)} now. Claude nodes can resume their conversations from their Restart button, and terminals can restart below their saved output.`,
        verb: `Stop ${count(info.running)}`,
        cancelLabel: 'Keep running',
        attrs: { 'data-host-confirm': 'stop' },
        verbAttrs: { 'data-host-action': 'stop-confirm' },
        cancelAttrs: { 'data-host-action': 'stop-cancel' }
      },
      stop
    )
  const hostIsThere = info.mode === 'background' || info.mode === 'other-version'

  return (
    <div className="set-group" data-host-mode={info.mode}>
      <div className="set-row">
        <div className="set-text">
          <span className="set-title">Session host</span>
          <p className="set-help">A background program that keeps terminals and Claude running while Patchbay is closed. It ends by itself if no app has connected for a week of the PC being on.</p>
        </div>
        <div className="set-control">
          <span className="set-value" data-host-state>
            {stateLine(info)}
          </span>
        </div>
      </div>

      {info.problem && (
        <div className="set-row set-row-wide">
          <p className="field-problem" role="alert">
            {info.problem}
          </p>
        </div>
      )}

      {info.pid !== undefined && (
        <div className="set-row">
          <div className="set-text">
            <span className="set-title">Details</span>
          </div>
          <div className="set-control">
            <span className="set-value">
              Process {info.pid}, version {info.version}, protocol {info.protocol}
              {info.protocol !== info.expectedProtocol ? ` (this app needs ${info.expectedProtocol})` : ''}
              {memory ? `, ${memory} of its own` : ''}
            </span>
          </div>
        </div>
      )}

      {info.mode === 'other-version' && (
        <div className="set-row">
          <div className="set-text">
            <span className="set-title">What to do with it</span>
            <p className="set-help">Stopping ends those sessions. Claude nodes resume their conversations, and terminals come back as new shells below their saved output. Quitting leaves them running, so you can finish in the older version first.</p>
          </div>
          <div className="set-control set-input-row">
            <button type="button" className="btn" data-host-action="quit-other" onClick={() => void bridge.resolveOtherHost('quit')}>
              Quit and leave them
            </button>
            <button type="button" className="btn btn-danger" data-host-action="stop-other" onClick={() => void bridge.resolveOtherHost('stop-it')}>
              Stop them and continue
            </button>
          </div>
        </div>
      )}

      {hostIsThere && info.mode !== 'other-version' && (
        <div className="set-row">
          <div className="set-text">
            <span className="set-title">Stop the host</span>
            <p className="set-help">Ends every session in it. Patchbay stays open.</p>
          </div>
          <div className="set-control set-input-row">
            <button type="button" className="btn btn-risky" data-host-action="stop" disabled={busy} onClick={askStop}>
              {busy ? 'Stopping…' : 'Stop…'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
