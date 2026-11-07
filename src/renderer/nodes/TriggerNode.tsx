import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo, useEffect, useState } from 'react'
import { describeSchedule } from '../../core/trigger/schedule'
import type { TriggerNode as TriggerModel } from '../../shared/model'
import { bridge } from '../bridge'
import type { FlowNode } from '../flowMapping'
import { KindIcon } from '../icons'
import { closeNodes, useStore } from '../store'
import { nextLabel, OUTCOME_LABELS, STATE_LABELS, triggerState } from '../triggerView'
import { EditableTitle, Resizer } from './NodeChrome'

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
  const state = triggerState(node)
  const armed = state === 'armed'
  const now = useNow(armed && node.nextAt !== null)
  const target = useStore((s) => s.doc?.nodes.find((n) => n.id === node.targetId))
  const [problem, setProblem] = useState<string | null>(null)

  const runNow = async (): Promise<void> => {
    const r = await bridge.runTriggerNow(node.id)
    setProblem(r.ok ? null : r.reason)
  }

  return (
    <div className={`unit trigger trigger-${state}${selected ? ' unit-selected' : ''}`} data-trigger-state={state}>
      <Resizer node={node} min={{ w: 300, h: 220 }} />
      <Handle className="jack" type="source" position={Position.Right} aria-label="Drag to a terminal or Claude window to choose what this sends to" />
      <header className="unit-head pb-drag">
        <KindIcon kind="trigger" />
        <EditableTitle node={node} />
        <span className={`trigger-chip trigger-chip-${state}`}>{STATE_LABELS[state]}</span>
        <button className="icon-btn nodrag" aria-label={`Delete ${node.title}`} title="Delete trigger" onClick={() => closeNodes([node.id])}>
          ×
        </button>
      </header>
      <div className="trigger-body nodrag nowheel">
        <dl className="trigger-facts">
          <dt>When</dt>
          <dd data-trigger="schedule">{describeSchedule(node.schedule)}</dd>
          <dt>Next</dt>
          <dd data-trigger="next">{nextLabel(node, now)}</dd>
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
              {r.detail && <span className="trigger-run-detail">{r.detail}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
})
