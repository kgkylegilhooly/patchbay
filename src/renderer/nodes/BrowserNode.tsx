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
import { BrowserEvidence } from './BrowserEvidence'
import { isBlankPage } from './browserEmpty'
import './browserEmpty.css'
import { useHeaderZoom } from '../useHeaderZoom'

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

/**
 * Over a blank page, which a webview draws white: what to do here, in the canvas's own colours. Clicking it puts the
 * cursor in the address bar. Gone as soon as a page loads, by the person or an agent.
 */
function EmptyPage({ node }: { node: BrowserNodeModel }): React.JSX.Element | null {
  const blank = useStore((s) => isBlankPage(s.browsers[node.id], node.url))
  if (!blank) return null
  return (
    <button
      type="button"
      className="browser-empty nodrag"
      data-browser-empty
      onClick={(e) => e.currentTarget.closest('.unit-browser')?.querySelector<HTMLInputElement>('.browser-address')?.focus()}
    >
      <Icon name="browser" size={22} />
      <span>Type an address above, or an agent can open a page here.</span>
    </button>
  )
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
  const headerZoom = useHeaderZoom(node.id)
  const notice = useStore((s) => s.browsers[node.id]?.notice)
  const [design, setDesign] = useState<DesignState>({ kind: 'off' })
  return (
    <>
      <Resizer node={node} min={{ w: 360, h: 240 }} />
      <Jacks />
      <div className={`unit unit-browser${selected ? ' unit-selected' : ''}`}>
        <header className="unit-head pb-drag" onDoubleClick={headerZoom}>
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
          <EmptyPage node={node} />
        </div>
      </div>
    </>
  )
})

function CloseButton({ node }: { node: BrowserNodeModel }): React.JSX.Element {
  return (
    <button className="icon-btn tool-btn nodrag" data-tool="close" aria-label={`Close ${node.title}`} title="Close" onClick={() => void closeBrowser(node.id)}>
      <Icon name="close" size={15} />
    </button>
  )
}

const closeBrowser = (id: string): Promise<void> => bridge.dispatch({ op: 'removeNodes', ids: [id], at: Date.now() })

