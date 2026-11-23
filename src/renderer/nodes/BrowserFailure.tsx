import { RETRY_EVERY_MS } from '../../shared/browserFailure'
import { bridge } from '../bridge'
import { Icon } from '../icons'
import { useStore } from '../store'
import './browserFailure.css'

/**
 * In place of the white page Chromium leaves when a load fails: what went wrong in plain words, with Try again. A dev
 * server's address is tried again on its own for a minute (main/browser/loadRetry.ts), and the page simply appears.
 */
export function BrowserFailurePanel({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const failure = useStore((s) => s.browsers[nodeId]?.failure ?? null)
  const loading = useStore((s) => !!s.browsers[nodeId]?.loading)
  if (!failure) return null
  const waiting = failure.retryAt !== null
  const status = waiting
    ? `Trying again every ${RETRY_EVERY_MS / 1000} seconds…`
    : failure.gaveUp
      ? 'Stopped trying on its own after a minute.'
      : loading
        ? 'Trying…'
        : null
  return (
    <div className="browser-failure nodrag" role="alert" data-browser-failure data-waiting={waiting || undefined}>
      <Icon name={waiting ? 'refresh' : 'browser'} size={22} />
      <strong className="browser-failure-title">{failure.title}</strong>
      {failure.detail && <span className="browser-failure-detail">{failure.detail}</span>}
      {status && <span className="browser-failure-status">{status}</span>}
      <div className="browser-failure-actions">
        <button type="button" className="btn" data-browser="try-again" onClick={() => void bridge.browserStep(nodeId, 'reload')}>
          Try again
        </button>
      </div>
      <code className="browser-failure-code" title={failure.url}>
        {failure.code}
      </code>
    </div>
  )
}
