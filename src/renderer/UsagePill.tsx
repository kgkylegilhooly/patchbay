import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { pillText, type AccountView, type LimitRow } from './usageView'

const REFRESH_MS = 30_000
/** Lets the pointer cross the gap between the pill and its panel without the panel shutting. */
const HOVER_CLOSE_MS = 220

/** Hidden when nothing is known, because a guess here would be worse than nothing. */
export function UsagePill(): React.JSX.Element | null {
  const usage = useStore((s) => s.usage)
  const mode = useStore((s) => s.usageMode)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS)
    return () => clearInterval(timer)
  }, [usage])
  useEffect(() => () => clearTimeout(closing.current), [])

  const pill = pillText(usage, now, mode)
  if (!pill) return null
  const show = (): void => {
    clearTimeout(closing.current)
    setNow(Date.now())
    setOpen(true)
  }
  const hide = (): void => {
    closing.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS)
  }
  return (
    <div className="usage-slot" onMouseEnter={show} onMouseLeave={hide}>
      <span className={`usage-pill usage-${pill.level}${pill.stale ? ' usage-stale' : ''}`} role="status" tabIndex={0} onFocus={show} onBlur={hide} title={pill.rows.length ? undefined : pill.detail}>
        <span className="usage-minibar" aria-hidden="true">
          <span className="usage-fill" style={{ width: `${pill.barPercent}%` }} />
        </span>
        {pill.text}
      </span>
      {open && (pill.rows.length > 0 || pill.codex) && (
        <div className="usage-panel" role="tooltip">
          <div className="usage-panel-head">
            <span>Usage</span>
            <span className="usage-panel-updated">{pill.updated}</span>
          </div>
          {(pill.rows.length > 0 || pill.claudeAccount) && (
            <section className="usage-section" data-agent="claude" aria-label="Claude">
              <div className="usage-section-name">Claude</div>
              {pill.rows.map((row) => (
                <LimitBar row={row} key={row.label} />
              ))}
              {pill.claudeAccount && <Account account={pill.claudeAccount} />}
            </section>
          )}
          {pill.codex && (
            <section className="usage-section" data-agent="codex" aria-label="Codex">
              <div className="usage-section-name">Codex</div>
              {pill.codex.rows.map((row) => (
                <LimitBar row={row} key={row.label} />
              ))}
              {pill.codex.problem && <p className="usage-problem">{pill.codex.problem}</p>}
              {pill.codex.account && <Account account={pill.codex.account} />}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function LimitBar({ row }: { row: LimitRow }): React.JSX.Element {
  return (
    <div className={`usage-row usage-${row.level}`}>
      <div className="usage-row-title">{row.label}</div>
      <div className="usage-bar">
        <span className="usage-fill" style={{ width: `${row.barPercent}%` }} />
      </div>
      <div className="usage-row-meta">
        <span>{row.percentText}</span>
        <span>{row.resets}</span>
      </div>
    </div>
  )
}

function Account({ account }: { account: AccountView }): React.JSX.Element {
  return (
    <div className="usage-account">
      <div className="usage-account-email">{account.email}</div>
      {account.detail && <div className="usage-account-detail">{account.detail}</div>}
    </div>
  )
}
