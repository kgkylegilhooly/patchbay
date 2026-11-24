import { useEffect, useState } from 'react'
import type { AboutInfo, AgentProgramInfo } from '../../shared/diagnostics'
import { Icon } from '../icons'
import { agentLine, buildLine, copiedText, copyButtonState, diagnosticsBridge, useDiagnosticsNote } from './diagnosticsUi'
import './diagnostics.css'

/** Settings' own row layout, as SettingsPage's Row draws it. */
function Row({ title, help, wide, children }: { title: string; help?: React.ReactNode; wide?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`set-row${wide ? ' set-row-wide' : ''}`}>
      <div className="set-text">
        <span className="set-title">{title}</span>
        {help && <div className="set-help">{help}</div>}
      </div>
      {children !== undefined && <div className="set-control">{children}</div>}
    </div>
  )
}

/**
 * Settings › About's first rows: which build this is, what it runs on, and each enabled agent's program and version.
 * The agents are asked when About opens, off the main thread, and the answers kept for the app's run.
 */
export function AboutBuildRows(): React.JSX.Element {
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [agents, setAgents] = useState<AgentProgramInfo[] | null>(null)
  useEffect(() => {
    let live = true
    const b = diagnosticsBridge()
    void b?.about().then((a) => live && setAbout(a))
    void b?.agents().then((a) => live && setAgents(a))
    return () => {
      live = false
    }
  }, [])
  return (
    <>
      <Row
        title="Version"
        help={
          about && (
            <>
              <span data-diag="build">{buildLine(about.build)}</span>
              <br />
              <span data-diag="runtime">
                Electron {about.electron}, Node {about.node}, {about.os}
              </span>
            </>
          )
        }
      >
        <span className="set-value">Patchbay {about?.version}</span>
      </Row>
      <Row wide title="Agents" help="The program each enabled agent starts, and its version.">
        <ul className="diag-agents" data-diag="agents" aria-busy={agents === null}>
          {agents === null && <li className="diag-agent-wait">Asking…</li>}
          {agents?.map((a) => (
            <li key={a.kind} data-diag-agent={a.kind}>
              <span className="diag-agent-name">{agentLine(a)}</span>
              {a.program && <code className="diag-agent-path">{a.program}</code>}
              {a.problem && <span className="diag-agent-problem">{a.problem}</span>}
            </li>
          ))}
        </ul>
      </Row>
    </>
  )
}

/** The log, its folder, and Copy diagnostics, which says here what it did. */
export function ReportRows(): React.JSX.Element {
  const [copied, setCopied] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const button = copyButtonState(busy)
  const copy = (): void => {
    const b = diagnosticsBridge()
    if (!b || busy) return
    setBusy(true)
    setCopied(null)
    void b
      .copy()
      .then((r) => setCopied({ ok: r.ok, text: copiedText(r) }))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <Row title="Log" help="When the window stopped responding or crashed, and how it recovered. Useful to share if Patchbay misbehaves.">
        <div className="diag-buttons">
          <button type="button" className="btn" data-cmd="open-log" onClick={() => void window.patchbay.openLog()}>
            Open log
          </button>
          <button type="button" className="btn" data-cmd="open-log-folder" aria-label="Open log folder" onClick={() => void diagnosticsBridge()?.openLogFolder()}>
            Open folder
          </button>
        </div>
      </Row>
      <Row
        title="Diagnostics"
        help={
          <>
            Versions, agent programs, how each Claude session's hooks are set up, session counts, memory and the last 40 log
            lines, as plain text for a bug report. Your user name is hidden, and no prompts, conversation text or tokens go in.
            {copied && (
              <span className={`diag-copied${copied.ok ? '' : ' diag-copied-bad'}`} role="status" data-diag="copied">
                {copied.text}
              </span>
            )}
          </>
        }
      >
        <button type="button" className="btn btn-solid" data-cmd="copy-diagnostics" aria-disabled={button['aria-disabled']} onClick={copy}>
          {button.label}
        </button>
      </Row>
    </>
  )
}

const SHOWN_MS = 6000

/** Copy diagnostics' answer when it came from Help or the palette, with nothing else on screen to say it. */
export function DiagnosticsToast(): React.JSX.Element | null {
  const note = useDiagnosticsNote((s) => s.note)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => useDiagnosticsNote.setState({ note: null }), SHOWN_MS)
    return () => clearTimeout(t)
  }, [note])
  if (!note) return null
  return (
    <div className="archived-toast" role="status" data-diag-toast={note.ok ? 'copied' : 'failed'}>
      <div className="archived-toast-text">
        <p className="archived-toast-head">{note.text}</p>
      </div>
      <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => useDiagnosticsNote.setState({ note: null })}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
