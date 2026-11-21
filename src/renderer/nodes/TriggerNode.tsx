import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo, useEffect, useState } from 'react'
import { describeSchedule } from '../../core/trigger/schedule'
import { describeLimits, limitsOf, preflightText, sourceNodeId } from '../../core/trigger/events'
import type { TriggerNode as TriggerModel } from '../../shared/model'
import { bridge } from '../bridge'
import type { FlowNode } from '../flowMapping'
import { Icon, KindIcon } from '../icons'
import { closeNodes, useStore } from '../store'
import { nextLabel, OUTCOME_LABELS, STATE_LABELS, triggerState } from '../triggerView'
import { EditableTitle, Resizer } from './NodeChrome'
import { useHeaderZoom } from '../useHeaderZoom'

/** The time now, ticking only while there's a countdown to show. Only this node renders for it. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/** The forms live with the canvas, which picks this up. */
function ask(kind: 'edit' | 'arm', id: string): void {
  useStore.setState({ triggerAsk: { kind, id } })
}

export const TriggerNode = memo(function TriggerNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as TriggerModel
  const headerZoom = useHeaderZoom(node.id)
  const state = triggerState(node)
  const armed = state === 'armed'
  const now = useNow(armed && node.nextAt !== null)
  const target = useStore((s) => s.doc?.nodes.find((n) => n.id === node.targetId))
  const sourceId = sourceNodeId(node.schedule)
  const sourceTitle = useStore((s) => (sourceId ? s.doc?.nodes.find((n) => n.id === sourceId)?.title : undefined))
  const limits = limitsOf(node)
  const [problem, setProblem] = useState<string | null>(null)

  const runNow = async (): Promise<void> => {
    const r = await bridge.runTriggerNow(node.id)
    setProblem(r.ok ? null : r.reason)
  }

  return (
    <div className={`unit trigger trigger-${state}${selected ? ' unit-selected' : ''}`} data-trigger-state={state}>
      <Resizer node={node} min={{ w: 300, h: 220 }} />
      <Handle className="jack" type="source" position={Position.Right} aria-label="Drag to a terminal or Claude window to choose what this sends to" />
      <header className="unit-head pb-drag" onDoubleClick={headerZoom}>
        <KindIcon kind="trigger" />
        <EditableTitle node={node} />
        <span className={`trigger-chip trigger-chip-${state}`}>{STATE_LABELS[state]}</span>
        <button className="icon-btn tool-btn nodrag" aria-label={`Delete ${node.title}`} title="Delete trigger" onClick={() => closeNodes([node.id])}>
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="trigger-body nodrag nowheel">
        <dl className="trigger-facts">
          <dt>When</dt>
          <dd data-trigger="schedule">{describeSchedule(node.schedule, () => sourceTitle, node)}</dd>
          <dt>Next</dt>
          <dd data-trigger="next">{nextLabel(node, now)}</dd>
          {node.preflight && (
            <>
              <dt>Only if</dt>
              <dd data-trigger="preflight">
                <code>{preflightText(node.preflight)}</code> exits 0
              </dd>
            </>
          )}
          {limits && (
            <>
              <dt>Limits</dt>
              <dd data-trigger="limits">{describeLimits(limits)}</dd>
            </>
          )}
          <dt>Sends to</dt>
          <dd data-trigger="target">{target ? `${target.title} (${target.kind === 'claude' ? 'Claude, when idle' : 'terminal'})` : 'Nothing yet. Drag from the jack on the right to a terminal or Claude window.'}</dd>
        </dl>
        <pre className="trigger-prompt" title={node.prompt}>
          {node.prompt || 'No prompt yet.'}
        </pre>
        <div className="trigger-actions">
          {armed ? (
            <button className="btn" data-trigger-action="disarm" onClick={() => void bridge.disarmTrigger(node.id)}>
              Disarm
            </button>
          ) : (
            <button className="btn btn-solid" data-trigger-action="arm" onClick={() => ask('arm', node.id)}>
              Arm…
            </button>
          )}
          <button className="btn" data-trigger-action="run" disabled={!armed} title={armed ? 'Send it now' : 'Arm it first'} onClick={() => void runNow()}>
            Run now
          </button>
          <button className="btn" data-trigger-action="edit" onClick={() => ask('edit', node.id)}>
            Edit…
          </button>
        </div>
        {problem && (
          <p className="trigger-problem" role="alert">
            {problem}
          </p>
        )}
        <ol className="trigger-runs" aria-label="Recent runs">
          {node.runs.length === 0 && <li className="trigger-run-none">No runs yet.</li>}
          {node.runs.map((r) => (
            <li key={r.id} className={`trigger-run trigger-run-${r.outcome}`} data-outcome={r.outcome}>
              <span className="trigger-run-outcome">{OUTCOME_LABELS[r.outcome]}</span>
              <time>{new Date(r.at).toLocaleString()}</time>
              {r.source === 'manual' && <span className="trigger-run-manual">by hand</span>}
              {(r.repeats ?? 1) > 1 && <span className="trigger-run-manual">{r.repeats} times</span>}
              {r.event && <span className="trigger-run-event">{r.event}</span>}
              {r.detail && <span className="trigger-run-detail">{r.detail}</span>}
              {r.preflight && (
                <pre className="trigger-run-check" title="The end of the check's output">
                  {`Check exited ${r.preflight.code ?? '(no code)'}${r.preflight.tail ? `: ${r.preflight.tail}` : ''}`}
                </pre>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
})
