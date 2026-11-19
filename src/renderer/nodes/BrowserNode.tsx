import type { NodeProps } from '@xyflow/react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { BLANK, partitionFor } from '../../shared/browserPolicy'
import type { BrowserNode as BrowserNodeModel } from '../../shared/model'
import { bridge } from '../bridge'
import type { FlowNode } from '../flowMapping'
import { Icon } from '../icons'
import { patchNode, useStore } from '../store'
import { DesignStrip, startPicking, type DesignState } from './DesignStrip'
import { Jacks, Resizer, EditableTitle } from './NodeChrome'
import type { BrowserAttempt, EvidenceCapture } from '../../shared/browserEvidence'
import './browserEvidence.css'

/** How long after an agent's last action the node keeps saying it's being driven. */
const DRIVING_SHOWN_MS = 15_000

/** Just the webview methods used here. Electron's own type lives in a module the renderer doesn't load. */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
}

/**
 * The page itself. It's made once and never updated from props: changing a webview's src would be a second route to
 * navigating, so after the first load everything goes through main, under one set of rules. Moving this element in the
 * page would reload it, so it stays where it is for as long as the node is on screen.
 */
function PageView({ node }: { node: BrowserNodeModel }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const first = useRef({ url: node.url, partition: partitionFor(node) })
  useEffect(() => {
    const view = document.createElement('webview') as WebviewElement
    // Must be set before it's in the document. Pop-ups are let through only so main can contain them: see guard.ts.
    view.setAttribute('partition', first.current.partition)
    view.setAttribute('allowpopups', '')
    view.setAttribute('src', first.current.url)
    view.className = 'browser-page'
    // Electron can refuse the id until the page is ready, so a refusal waits for dom-ready and asks again. A page
    // already taken off the screen has nothing to attach.
    const attach = (): boolean => {
      if (!view.isConnected) return true
      try {
        void bridge.browserAttached(node.id, view.getWebContentsId())
        return true
      } catch {
        return false
      }
    }
    view.addEventListener('did-attach', () => {
      if (!attach()) view.addEventListener('dom-ready', () => void attach(), { once: true })
    })
    host.current?.appendChild(view)
    return () => view.remove()
  }, [node.id])
  return <div ref={host} className="browser-host nodrag nopan nowheel" />
}

function useDriving(nodeId: string): { by: string; action: string } | null {
  const driving = useStore((s) => s.browsers[nodeId]?.driving ?? null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!driving) return
    const left = driving.at + DRIVING_SHOWN_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => tick((n) => n + 1), left + 50)
    return () => clearTimeout(timer)
  }, [driving])
  return driving && Date.now() - driving.at < DRIVING_SHOWN_MS ? driving : null
}

/** Always one click away. Taking control is saved on the node, and main checks it before every agent step. */
function ControlStrip({ node }: { node: BrowserNodeModel }): React.JSX.Element | null {
  const driving = useDriving(node.id)
  if (node.held) {
    return (
      <div className="strip strip-held-browser" data-browser-strip="held">
        <div className="strip-text">
          <span>You have control. Agents are refused here until you hand it back.</span>
        </div>
        <div className="strip-actions">
          <button className="btn nodrag" data-browser="hand-back" onClick={() => patchNode(node.id, { held: false })}>
            Hand back
          </button>
        </div>
      </div>
    )
  }
  if (!driving) return null
  return (
    <div className="strip strip-driving" data-browser-strip="driving">
      <div className="strip-text">
        <span className="driving-dot" aria-hidden="true" />
        <strong>{driving.by} is driving this browser</strong>
        <span>{driving.action}</span>
      </div>
      <div className="strip-actions">
        <button className="btn btn-solid nodrag" data-browser="take-control" onClick={() => patchNode(node.id, { held: true })}>
          Take control
        </button>
      </div>
    </div>
  )
}

function AddressBar({ node, design, setDesign }: { node: BrowserNodeModel; design: DesignState; setDesign: (s: DesignState) => void }): React.JSX.Element {
  const state = useStore((s) => s.browsers[node.id])
  const shown = state?.url || node.url
  // While an agent is driving, the strip below carries the button instead.
  const driving = useDriving(node.id)
  const [draft, setDraft] = useState<string | null>(null)
  const go = useCallback(() => {
    if (draft === null) return
    void bridge.browserNavigate(node.id, draft).then((r) => r.ok && setDraft(null))
  }, [draft, node.id])
  return (
    <form
      className="browser-bar nodrag"
      onSubmit={(e) => {
        e.preventDefault()
        go()
      }}
    >
      <button type="button" className="icon-btn" data-browser="back" aria-label="Back" title="Back" disabled={!state?.canBack} onClick={() => void bridge.browserStep(node.id, 'back')}>
        <Icon name="arrow-left" />
      </button>
      <button type="button" className="icon-btn" data-browser="forward" aria-label="Forward" title="Forward" disabled={!state?.canForward} onClick={() => void bridge.browserStep(node.id, 'forward')}>
        <Icon name="arrow-right" />
      </button>
      {state?.loading ? (
        <button type="button" className="icon-btn" data-browser="stop" aria-label="Stop loading" title="Stop loading" onClick={() => void bridge.browserStep(node.id, 'stop')}>
          <Icon name="close" />
        </button>
      ) : (
        <button type="button" className="icon-btn" data-browser="reload" aria-label="Reload" title="Reload" onClick={() => void bridge.browserStep(node.id, 'reload')}>
          <Icon name="refresh" />
        </button>
      )}
      <input
        className="browser-address"
        aria-label="Address"
        placeholder="Enter an address"
        spellCheck={false}
        title={state?.title || undefined}
        value={draft ?? (shown === BLANK ? '' : shown)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
      <button
        type="button"
        className={`btn browser-design${design.kind === 'off' ? '' : ' btn-on'}`}
        data-browser="design"
        aria-pressed={design.kind !== 'off'}
        title="Design mode: pick an element and send it to an agent"
        onClick={() => (design.kind === 'picking' ? void bridge.browserCancelPick(node.id) : startPicking(node.id, setDesign))}
      >
        Design
      </button>
      {!node.held && !driving && (
        <button type="button" className="btn browser-take" data-browser="take-control-bar" title="Refuse every agent verb here until you hand it back" onClick={() => patchNode(node.id, { held: true })}>
          Take control
        </button>
      )}
    </form>
  )
}

export const BrowserNode = memo(function BrowserNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as BrowserNodeModel
  const notice = useStore((s) => s.browsers[node.id]?.notice)
  const [design, setDesign] = useState<DesignState>({ kind: 'off' })
  return (
    <>
      <Resizer node={node} min={{ w: 360, h: 240 }} />
      <Jacks />
      <div className={`unit unit-browser${selected ? ' unit-selected' : ''}`}>
        <header className="unit-head pb-drag">
          <Icon name="browser" size={14} />
          <EditableTitle node={node} />
          <span className="head-space" />
          <CloseButton node={node} />
        </header>
        <AddressBar node={node} design={design} setDesign={setDesign} />
        <ControlStrip node={node} />
        <DesignStrip nodeId={node.id} state={design} set={setDesign} />
        <BrowserEvidence nodeId={node.id} />
        {notice && (
          <div className="strip strip-browser-notice" role="status" data-browser-notice>
            <div className="strip-text">
              <span>{notice}</span>
            </div>
          </div>
        )}
        <div className="unit-body">
          <PageView node={node} />
        </div>
      </div>
    </>
  )
})

function CloseButton({ node }: { node: BrowserNodeModel }): React.JSX.Element {
  return (
    <button className="icon-btn nodrag" aria-label={`Close ${node.title}`} title="Close" onClick={() => void closeBrowser(node.id)}>
      ×
    </button>
  )
}

const closeBrowser = (id: string): Promise<void> => bridge.dispatch({ op: 'removeNodes', ids: [id], at: Date.now() })

function EvidencePicture({ attempt, capture, index }: { attempt: BrowserAttempt; capture: EvidenceCapture; index: number }): React.JSX.Element {
  const [image, setImage] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    void bridge.browserEvidenceImage(attempt.nodeId, attempt.id, index).then(value => { if (alive) { setImage(value); setLoaded(true) } })
    return () => { alive = false }
  }, [attempt.nodeId, attempt.id, index, capture.state])
  return <figure>
    <figcaption>{new Date(capture.at).toLocaleTimeString()} · {capture.viewport.preset ?? 'custom'} {capture.viewport.width} × {capture.viewport.height}</figcaption>
    {image ? <a href={image} download={`browser-${attempt.id}-${index}.png`}><img src={image} alt={`Observed page at ${new Date(capture.at).toISOString()}`} /></a> : <p>{loaded ? capture.reason ?? 'Screenshot unavailable or expired.' : 'Loading screenshot…'}</p>}
  </figure>
}

function BrowserEvidence({ nodeId }: { nodeId: string }): React.JSX.Element {
  const attempts = useStore(s => s.browsers[nodeId]?.evidence)
  const problem = useStore(s => s.browsers[nodeId]?.evidenceNotice)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  return <details className="browser-evidence nodrag nopan nowheel" data-browser-evidence onToggle={e => { if (e.target === e.currentTarget) setExpanded(e.currentTarget.open) }}>
    <summary>Evidence · {attempts?.length ?? 0} {attempts?.length === 1 ? 'attempt' : 'attempts'}</summary>
    {expanded && <div className="browser-evidence-content">
      <p>Observed captures and actions are partial evidence. They do not prove the entire feature works.</p>
      {problem && <p className="evidence-gap">{problem}</p>}
      {!attempts?.length && <p>No recorded verification. Agents can use browser verify to record a check.</p>}
      {attempts?.map(a => <details key={a.id} className="browser-attempt" open={(selected ?? attempts[0].id) === a.id} onToggle={e => { if (e.target === e.currentTarget && e.currentTarget.open) setSelected(a.id) }}>
        <summary>{a.state === 'recording' ? 'Recording' : a.state === 'incomplete' ? 'Incomplete capture' : 'Recorded capture'} · {new Date(a.startedAt).toLocaleString()}</summary>
        {(selected ?? attempts[0].id) === a.id && <>
        <p><strong>Observed</strong> · {a.viewport.preset ?? 'custom'} {a.viewport.width} × {a.viewport.height}<br />{a.url}</p>
        <p className="evidence-id">Attempt {a.id}{a.taskId && ` · Task ${a.taskId}`}</p>
        <p>Checkout revision: {a.revision ? `${a.revision.commit.slice(0, 12)}${a.revision.dirty ? ' · uncommitted changes' : ' · clean'}` : 'unavailable'}. Server revision is unknown.</p>
        <p><strong>Agent assertion:</strong> {a.assertion}. No human acceptance recorded here.</p>
        {a.gaps.map(g => <p className="evidence-gap" key={g}>{g}</p>)}
        <div className="evidence-pictures">{a.captures.map((c, i) => <EvidencePicture key={i} attempt={a} capture={c} index={i} />)}</div>
        <details><summary>Observed actions ({a.actions.length})</summary><ol>{a.actions.map((s, i) => <li key={i}>{new Date(s.at).toLocaleTimeString()} · {s.action} · {s.state}<br /><small>{s.url} · page {s.pageId}</small></li>)}</ol></details>
        <details><summary>Observed diagnostics ({a.diagnostics.length})</summary>
          <p>Since recording began. Console text, request headers and bodies are omitted for privacy. Empty logs are not proof of success.</p>
          {a.diagnostics.map((d, i) => <p key={i}>{new Date(d.at).toLocaleTimeString()} · {d.kind} · {d.message} {d.status ?? d.failure ?? ''}<br />{d.method} {d.url}<br /><small>Page {d.pageId} · {d.pageUrl} · attempt {d.attemptId}</small></p>)}
        </details>
        </>}
      </details>)}
    </div>}
  </details>
}
