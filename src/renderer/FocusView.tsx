import { memo, useEffect, useRef } from 'react'
import { isSessionNode, type SessionNode } from '../shared/model'
import { closePane, leaves, setRatio, showIn, splitPane, type Pane, type PanePath } from './focusLayout'
import { focusSoon, leaveFocus, registerSlot, setFocusLayout } from './focusState'
import { Icon, KindIcon } from './icons'
import { useStore } from './store'

/** Where a window in a pane is drawn. Its card moves in here, so there's still only one view of each session. */
function Slot({ nodeId }: { nodeId: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    registerSlot(nodeId, ref.current)
    return () => registerSlot(nodeId, null)
  }, [nodeId])
  return <div ref={ref} className="focus-slot" data-focus-slot={nodeId} />
}

function Leaf({ root, path, nodeId }: { root: Pane; path: PanePath; nodeId: string | null }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const sessions = (doc?.nodes ?? []).filter(isSessionNode).filter((n) => !n.projectId || n.projectId === doc?.activeProjectId)
  const shown = new Set(leaves(root).map((l) => l.nodeId))
  const only = path.length === 0
  return (
    <div className="focus-pane" data-focus-pane={path.join('') || 'root'}>
      <div className="focus-pane-bar">
        <select
          aria-label="Window in this pane"
          value={nodeId ?? ''}
          onChange={(e) => setFocusLayout(showIn(root, path, e.target.value || null))}
        >
          <option value="">Empty</option>
          {sessions.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
              {shown.has(n.id) && n.id !== nodeId ? ' (in another pane)' : ''}
            </option>
          ))}
        </select>
        <span className="focus-pane-space" />
        <button type="button" className="icon-btn" data-focus="split-right" aria-label="Split right" title="Split right" onClick={() => setFocusLayout(splitPane(root, path, 'row'))}>
          <span className="focus-split focus-split-row" aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn" data-focus="split-down" aria-label="Split down" title="Split down" onClick={() => setFocusLayout(splitPane(root, path, 'column'))}>
          <span className="focus-split focus-split-column" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-focus="close-pane"
          aria-label={only ? 'Empty this pane' : 'Take this pane out of the view'}
          title={only ? 'Empty this pane. The window keeps running on the canvas.' : 'Take this pane out of the view. Its window keeps running on the canvas.'}
          onClick={() => setFocusLayout(closePane(root, path))}
        >
          <Icon name="minus" size={13} />
        </button>
      </div>
      <div className="focus-pane-body">{nodeId ? <Slot nodeId={nodeId} /> : <EmptyPane root={root} path={path} sessions={sessions.filter((n) => !shown.has(n.id))} />}</div>
    </div>
  )
}

/** An empty pane offers the windows that aren't in the view yet, one click each. */
function EmptyPane({ root, path, sessions }: { root: Pane; path: PanePath; sessions: SessionNode[] }): React.JSX.Element {
  if (!sessions.length) return <p className="focus-empty">Every window is already in the view. Open another from the canvas, or close this pane.</p>
  return (
    <div className="focus-empty">
      <p>Show a window here:</p>
      <ul className="focus-choices">
        {sessions.map((n) => (
          <li key={n.id}>
            <button type="button" className="focus-choice" data-focus-choice={n.id} onClick={() => showAndFocus(root, path, n.id)}>
              <KindIcon kind={n.kind} agent={n.kind === 'claude' ? n.agent : undefined} />
              <span>{n.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function showAndFocus(root: Pane, path: PanePath, nodeId: string): void {
  setFocusLayout(showIn(root, path, nodeId))
  focusSoon(nodeId)
}

function Split({ root, path, pane }: { root: Pane; path: PanePath; pane: Extract<Pane, { type: 'split' }> }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const drag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const el = box.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent): void => {
      const ratio = pane.dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height
      setFocusLayout(setRatio(useStore.getState().focus ?? root, path, ratio))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('focus-dragging')
    }
    document.body.classList.add('focus-dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div ref={box} className={`focus-split-box focus-${pane.dir}`}>
      <div className="focus-part" style={{ flexGrow: pane.ratio }}>
        <PaneView root={root} path={[...path, 'a']} pane={pane.a} />
      </div>
      <div className="focus-divider" role="separator" aria-orientation={pane.dir === 'row' ? 'vertical' : 'horizontal'} data-focus-divider={path.join('') || 'root'} onPointerDown={drag} />
      <div className="focus-part" style={{ flexGrow: 1 - pane.ratio }}>
        <PaneView root={root} path={[...path, 'b']} pane={pane.b} />
      </div>
    </div>
  )
}

function PaneView({ root, path, pane }: { root: Pane; path: PanePath; pane: Pane }): React.JSX.Element {
  return pane.type === 'leaf' ? <Leaf root={root} path={path} nodeId={pane.nodeId} /> : <Split root={root} path={path} pane={pane} />
}

/** Session windows in split panes, filling the app, instead of the canvas. */
function FocusViewView(): React.JSX.Element | null {
  const focus = useStore((s) => s.focus)
  if (!focus) return null
  return (
    <section className="focus-view" aria-label="Focus view">
      <header className="focus-head">
        <Icon name="grid" size={14} />
        <strong>Focus view</strong>
        <span className="focus-hint">Split a pane with the buttons on its bar, drag the dividers, and move between panes with Ctrl+Shift+arrows.</span>
        <span className="focus-pane-space" />
        <button type="button" className="btn" data-focus="leave" onClick={leaveFocus}>
          Back to canvas
        </button>
      </header>
      <div className="focus-root">
        <PaneView root={focus} path={[]} pane={focus} />
      </div>
    </section>
  )
}

/** Drawn again only when what it's given changes, so moving things on the canvas leaves it alone. */
export const FocusView = memo(FocusViewView)
