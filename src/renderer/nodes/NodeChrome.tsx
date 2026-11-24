import { Handle, NodeResizer, Position, useReactFlow } from '@xyflow/react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PendingApproval } from '../../shared/contract'
import { isSessionNode, whereShown, type AgentStatus, type CanvasNode } from '../../shared/model'
import { bridge } from '../bridge'
import { Icon, KindIcon } from '../icons'
import { PortChips } from '../PortChips'
import { FilesChip } from '../FilesChip'
import { closeNodes, dismissNamingError, dismissRunProblem, restartNode, undoable, useStore } from '../store'
import { contextLabel } from '../usageView'
import { RunDot, RunLabel, StatusBadge, StatusDot } from './StatusBadge'
import { MaximizeTool, WindowTools } from './WindowTools'
import { SetupHold } from './SetupHold'
import { SessionTaskOutcomes } from '../tasks/TaskOutcomes'
import { SubagentEye } from '../subagents/SubagentEye'
import { useHeaderZoom } from '../useHeaderZoom'
import { useAgentStop } from '../agentStops'
import { ledTokens, runMapColor, statusMapColor } from '../minimapColors'
import { setupHoldOf } from '../status/setupStatus'
import { headerFolder, keyBadge } from '../zoomTier'
import { JoinedStrip } from '../sessionSyncUi'
import '../zoom.css'
import { confirmThen } from '../shell/confirmStore'
import { askReview, reviewShown, reviewViewport, useFarReview } from '../farReview'
import { measureSafeArea } from '../safeArea'
import { StartFixActions } from './StartFixActions'
import { failedStart } from '../status/startFailure'
import { AwayStrip } from './AwayStrip'

/** Double-click to rename. Enter or leaving the field saves, and Esc cancels. */
export function EditableTitle({ node }: { node: CanvasNode }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const asked = useStore((s) => s.renaming === node.id)
  useEffect(() => {
    if (!asked) return
    setDraft(node.title)
    useStore.setState({ renaming: null })
  }, [asked, node.title])
  if (draft === null) {
    return (
      <span className="title" title="Double-click to rename" onDoubleClick={() => setDraft(node.title)}>
        {node.title}
      </span>
    )
  }
  const save = (): void => {
    const title = draft.trim()
    if (title && title !== node.title) undoable('rename', [{ op: 'patchNode', id: node.id, patch: { title } }])
    setDraft(null)
  }
  return (
    <input
      className="title-input nodrag"
      aria-label="Node title"
      autoFocus
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

export function Jacks({ hidden = false }: { hidden?: boolean }): React.JSX.Element {
  return (
    <>
      <Handle
        className={hidden ? 'jack jack-hidden' : 'jack'}
        type="target"
        position={Position.Left}
        isConnectable={!hidden}
        aria-label="Input jack"
      />
      <Handle
        className={hidden ? 'jack jack-hidden' : 'jack'}
        type="source"
        position={Position.Right}
        isConnectable={!hidden}
        aria-label="Output jack, drag to another node to link them"
      />
    </>
  )
}

export function Resizer({ node, min }: { node: CanvasNode; min: { w: number; h: number } }): React.JSX.Element {
  return (
    <NodeResizer
      minWidth={min.w}
      minHeight={min.h}
      handleClassName="grip"
      lineClassName="grip-line"
      onResizeEnd={(_e, p) => undoable('resize', [{ op: 'patchNode', id: node.id, patch: { x: p.x, y: p.y, width: p.width, height: p.height } }])}
    />
  )
}

function Approval({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const approval = useStore((s) => s.approvals.find((a) => a.nodeId === nodeId))
  // Keyed, so the next request starts on one line again.
  return approval ? <ApprovalStrip key={approval.requestId} approval={approval} /> : null
}

/**
 * One line of what's being asked, and Show all when that line doesn't hold it: the window is narrower than the
 * text, or the summary was cut. Nobody should have to approve a command they can't read the end of.
 */
function ApprovalStrip({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const text = useRef<HTMLElement>(null)
  // Review… on a zoomed-out tile brought the view here: show the whole command.
  const reviewing = useFarReview((s) => s.requestId === approval.requestId)
  useEffect(() => {
    if (!reviewing) return
    setOpen(true)
    reviewShown()
  }, [reviewing])
  useEffect(() => {
    const el = text.current
    if (!el || open) return
    const measure = (): void => setClipped(el.scrollWidth > el.clientWidth)
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(el)
    return () => watcher.disconnect()
  }, [open])
  const more = open || clipped || approval.detail !== approval.summary
  return (
    <div className={`strip strip-approval${open ? ' strip-open' : ''}`}>
      <div className="strip-text">
        <strong>{approval.tool}</strong>
        <code ref={text} className={open ? 'nodrag nowheel' : undefined}>
          {open ? approval.detail : approval.summary}
        </code>
        {more && (
          <button className="strip-more nodrag" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      <div className="strip-actions">
        <button className="btn btn-solid" onClick={() => void bridge.answerApproval(approval.requestId, 'allow')}>
          Approve
        </button>
        {approval.always && (
          // Claude's own "don't ask again" rule, saved by Claude where it says: never your own or the shared settings.
          <button
            className="btn btn-always"
            data-cmd="approve-always"
            title={`Approve, and don't ask again for ${approval.always.rule} ${approval.always.where}`}
            onClick={() => void bridge.answerApproval(approval.requestId, 'allow-always')}
          >
            Always allow
          </button>
        )}
        <button className="btn" onClick={() => void bridge.answerApproval(approval.requestId, 'deny')}>
          Deny
        </button>
      </div>
    </div>
  )
}

function Held({ node }: { node: CanvasNode }): React.JSX.Element | null {
  const names = useStore((s) => {
    if (node.kind !== 'claude' || node.after.length === 0) return ''
    return node.after.map((id) => s.doc?.nodes.find((n) => n.id === id)?.title ?? id).join(', ')
  })
  return (
    <div className="strip strip-held">
      <div className="strip-text">
        <span>Waiting for: {names || 'another node'}</span>
      </div>
      <div className="strip-actions">
        <button className="btn" onClick={() => void bridge.startNode(node.id)}>
          Start now
        </button>
      </div>
    </div>
  )
}

/**
 * The second line of a header drawn zoomed out (zoom.css shows it then): the status word (a run's own, for a run
 * command) and the one badge you'd zoom in to read, such as what's being asked.
 */
function FarMeta({ node, status, folder }: { node: CanvasNode; status: AgentStatus | null; folder: string }): React.JSX.Element {
  const approval = useStore((s) => s.approvals.find((a) => a.nodeId === node.id))
  const run = useStore((s) => (node.kind === 'run' ? s.runs[node.id] : undefined))
  const context = contextLabel(useStore((s) => s.usage.nodes[node.id]))
  const badge = keyBadge({ approval: approval ? { tool: approval.tool, summary: approval.summary } : null, context, folder })
  return (
    <span className="head-far">
      {/* Asking: what's asked and the answer buttons say it, so the status word makes room for them. */}
      {approval ? null : node.kind === 'run' ? <RunLabel run={run} /> : status && <StatusBadge status={status} nodeId={node.id} />}
      {badge && (
        <span className={`key-badge key-badge-${badge.tone}`} title={approval ? `${approval.tool}: ${approval.detail}` : badge.title}>
          {badge.text}
        </span>
      )}
      {approval && <FarAnswer approval={approval} />}
    </span>
  )
}

/**
 * A prompt in a zoomed-out tile: Deny, which is safe, and Review…, which zooms to the window with the whole command
 * shown in its strip, where Approve is. The tile can't show all of a command, so it never approves one (farReview.ts).
 */
function FarAnswer({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const flow = useReactFlow()
  const what = `${approval.tool}: ${approval.detail}`
  const review = (): void => {
    const internal = flow.getInternalNode(approval.nodeId)
    const area = measureSafeArea()
    if (!internal || !area) return
    askReview(approval.requestId)
    const node = { ...internal.internals.positionAbsolute, width: internal.measured.width ?? 0, height: internal.measured.height ?? 0 }
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    void flow.setViewport(reviewViewport(node, area), { duration: still ? 0 : 260 })
  }
  return (
    <span className="far-answer">
      <button type="button" className="far-act far-act-ok nodrag" data-far-answer="review" title={`Zoom in to read the whole command, then approve or deny it: ${what}`} onClick={review}>
        Review…
      </button>
      <button type="button" className="far-act nodrag" data-far-answer="deny" title={`Deny ${what}`} onClick={() => void bridge.answerApproval(approval.requestId, 'deny')}>
        Deny
      </button>
    </span>
  )
}

function CloseControl({ node, status }: { node: CanvasNode; status: AgentStatus | null }): React.JSX.Element {
  const busy = status === 'working' || status === 'needs-you'
  // The same question the canvas menu's Close asks, in the one confirmation dialog.
  const askClose = (): void =>
    void confirmThen(
      {
        title: 'Close window?',
        message: status === 'working' ? 'Still working. Close anyway?' : 'Waiting on you. Close anyway?',
        verb: 'Close window',
        cancelLabel: 'Keep',
        attrs: { 'data-confirm': 'close' }
      },
      () => closeNodes([node.id])
    )
  return (
    <button
      className="icon-btn tool-btn nodrag"
      data-tool="close"
      aria-label={`Close ${node.title}`}
      title="Close"
      onClick={() => (busy ? askClose() : closeNodes([node.id]))}
    >
      <Icon name="close" size={15} />
    </button>
  )
}

export function NodeChrome({
  node,
  status,
  selected,
  children
}: {
  node: CanvasNode
  status: AgentStatus | null
  selected?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const error = useStore((s) => s.errors[node.id])
  const usage = useStore((s) => s.usage.nodes[node.id])
  const context = contextLabel(usage)
  const run = useStore((s) => s.runs[node.id])
  const isRun = node.kind === 'run'
  const cwd = isSessionNode(node) ? whereShown(node) : ''
  const canRestart = status === 'exited' || !!error
  const namingError = useStore((s) => s.namingError[node.id])
  const runProblem = useStore((s) => s.runProblem[node.id])
  const maximized = useStore((s) => s.maximized === node.id)
  const slot = useStore((s) => (s.focus ? s.focusSlots[node.id] : undefined))
  const headerZoom = useHeaderZoom(node.id)
  const projectFolder = useStore((s) => s.doc?.projects.find((p) => p.id === node.projectId)?.folder)
  const folder = headerFolder(cwd, projectFolder)
  const stop = useAgentStop(status === 'unknown' ? node.id : undefined)
  // The colour a zoomed-out window's body is filled with: the minimap's, so the two always agree.
  const fill = isRun ? runMapColor(run, ledTokens()) : statusMapColor(status, stop, ledTokens(), Date.now(), setupHoldOf(node), failedStart(status, error))
  const classes = ['unit', selected ? 'unit-selected' : '', status === 'needs-you' ? 'unit-needs-you' : '', slot ? 'unit-in-pane' : maximized ? 'unit-maximized' : '']

  const card = (
    <div className={classes.join(' ')} style={{ '--status-fill': fill } as React.CSSProperties}>
      <header className="unit-head unit-head-session pb-drag" onDoubleClick={headerZoom}>
        {isRun ? <RunDot run={run} /> : <StatusDot status={status} nodeId={node.id} />}
        <KindIcon kind={node.kind} agent={node.kind === 'claude' ? node.agent : undefined} />
        <EditableTitle node={node} />
        {isSessionNode(node) && <SessionTaskOutcomes sessionId={node.id} />}
        {node.kind === 'claude' && <SubagentEye nodeId={node.id} />}
        {status && <StatusBadge status={status} nodeId={node.id} />}
        {isRun && <RunLabel run={run} />}
        {node.kind === 'run' && node.launch && (
          <span className="run-launch" title={`From ${node.launch.folder}\\.vscode\\launch.json, read again at each run`}>
            launch.json
          </span>
        )}
        {context && (
          <span className={`unit-context usage-${context.level}`} title={context.detail}>
            {context.text}
          </span>
        )}
        {node.kind === 'claude' && <FilesChip nodeId={node.id} />}
        {folder && (
          <span className="cwd" title={cwd}>
            {folder}
          </span>
        )}
        {isRun && <PortChips nodeId={node.id} />}
        {isRun && (
          <span className="run-buttons">
            {run?.running && (
              <button className="btn nodrag" data-run="stop" onClick={() => void bridge.stopRun(node.id)}>
                Stop
              </button>
            )}
            <button className="btn nodrag" data-run={run?.running ? 'restart' : 'run'} onClick={() => void restartNode(node.id)}>
              {run?.running ? 'Restart' : 'Run'}
            </button>
          </span>
        )}
        {canRestart && !isRun && (
          <button className="btn nodrag" onClick={() => void restartNode(node.id)}>
            Restart
          </button>
        )}
        <FarMeta node={node} status={isRun ? null : status} folder={folder} />
        <span className="head-tools">
          <WindowTools node={node} />
          <CloseControl node={node} status={status} />
          {/* Maximized, Restore is the rightmost control, where a window's own restore button is, so it isn't Close. */}
          {maximized && <MaximizeTool node={node} />}
        </span>
      </header>
      {error && (
        // Waiting for memory isn't a failure: it starts by itself, so it reads as a wait, not an alarm.
        <div className={error.fix === 'memory' ? 'strip strip-wait' : 'strip strip-error'} role={error.fix === 'memory' ? 'status' : 'alert'}>
          <div className="strip-text">
            <span>{error.message}</span>
          </div>
          <StartFixActions node={node} error={error} />
        </div>
      )}
      {status !== 'exited' && <JoinedStrip id={node.id} />}
      {runProblem && (
        <div className="strip strip-error" role="alert" data-run-problem>
          <div className="strip-text">
            <span>{runProblem}</span>
          </div>
          <div className="strip-actions">
            <button className="btn nodrag" onClick={() => dismissRunProblem(node.id)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {namingError && (
        <div className="strip strip-error" role="alert" data-naming-error>
          <div className="strip-text">
            <span>{namingError}</span>
          </div>
          <div className="strip-actions">
            <button className="btn nodrag" onClick={() => dismissNamingError(node.id)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <Approval nodeId={node.id} />
      {node.kind === 'claude' && <AwayStrip nodeId={node.id} />}
      {status === 'queued' && node.kind === 'claude' && node.after.length > 0 && <Held node={node} />}
      <SetupHold node={node} />
      <div className="unit-body">{children}</div>
    </div>
  )
  // Drawn over the canvas rather than scaled up inside it. The node keeps its place and size underneath, so nothing
  // saved changes. Moving between the two draws a new terminal view, and the session behind it isn't touched.
  // In the focus view, the card moves into its pane in the same way.
  const target = slot ?? (maximized ? document.querySelector('.stage') : null)
  return (
    <>
      <Resizer node={node} min={{ w: 300, h: 180 }} />
      <Jacks />
      {target ? createPortal(card, target) : card}
    </>
  )
}
