import { useReactFlow } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { currentAttempt, planStep } from '../../core/workflow/engine'
import { stepOutputs, type OutputValue, type StepAttempt, type WorkflowRun } from '../../shared/workflow'
import type { PersonAction } from '../../shared/workflowBridge'
import { useStore } from '../store'
import { workflows } from '../workflowBridge'
import { ATTEMPT_LABEL, chipRuns, earlierAttempts, needsPerson, runStrip, runSubject } from './runView'
import { attemptLook, workflowRunLook } from '../status/status'
import { StatusMark, StatusPair } from '../status/StatusMarks'
import { openRunPanel, useWorkflowUi } from './workflowUi'
import './workflows.css'
import { safePadding } from '../safeArea'

function Value({ value }: { value: OutputValue }): React.JSX.Element {
  if (value.type === 'text') {
    return value.text.length > 160 || value.text.includes('\n') ? (
      <details className="recipe-prompt">
        <summary>{value.text.slice(0, 80)}…</summary>
        <pre>{value.text}</pre>
      </details>
    ) : (
      <span className="workflow-text">{value.text}</span>
    )
  }
  return (
    <button type="button" className="btn workflow-file" title={`${value.path}\nsha256 ${value.sha256}\nfrom ${value.source}`} onClick={() => void workflows.openFile(value.path)}>
      {value.source.split(/[\\/]/).pop()}
    </button>
  )
}

/** What the person can do about the step a run stopped at. */
function StepActions({ run, attempt, act }: { run: WorkflowRun; attempt: StepAttempt; act: (a: PersonAction) => Promise<void> }): React.JSX.Element | null {
  const step = run.definition.steps.find((s) => s.key === attempt.step)!
  const [note, setNote] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  if (run.stopped) return null
  if (step.kind === 'review' && attempt.state === 'waiting-for-you') {
    const plan = planStep(run, step)
    return (
      <div className="workflow-actions" data-workflow-review={step.key}>
        <p className="workflow-question">{step.question}</p>
        {plan.ok && plan.show && (
          <dl className="workflow-outputs">
            {plan.show.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd><Value value={s.value} /></dd>
              </div>
            ))}
          </dl>
        )}
        <textarea rows={2} value={note} placeholder="A note for the next step, or what should change" onChange={(e) => setNote(e.target.value)} />
        <div className="workflow-row">
          <button type="button" className="btn btn-solid" onClick={() => void act({ type: 'decide', attemptId: attempt.id, decision: 'approve', ...(note.trim() ? { note } : {}) })} data-workflow-approve>
            Approve
          </button>
          <button type="button" className="btn" disabled={!note.trim()} onClick={() => void act({ type: 'decide', attemptId: attempt.id, decision: 'request-changes', note })} data-workflow-changes>
            Request changes
          </button>
        </div>
      </div>
    )
  }
  if (step.kind === 'agent' && attempt.idle) {
    const textOnly = step.outputs.every((o) => o.type === 'text' || o.required === false)
    return (
      <div className="workflow-actions">
        <p className="recipe-dim">The agent went idle without submitting its result. That doesn't finish the step.</p>
        <div className="workflow-row">
          <button type="button" className="btn" disabled={attempt.reminded} onClick={() => void act({ type: 'remind', attemptId: attempt.id })}>
            {attempt.reminded ? 'Reminded' : 'Remind to submit'}
          </button>
        </div>
        {textOnly && (
          <details className="workflow-mark-done">
            <summary>Mark done yourself</summary>
            {step.outputs.filter((o) => o.type === 'text').map((o) => (
              <label key={o.key} className="field">
                <span className="field-label">{o.label || o.key}</span>
                <input value={fields[o.key] ?? ''} onChange={(e) => setFields((f) => ({ ...f, [o.key]: e.target.value }))} />
              </label>
            ))}
            <button
              type="button"
              className="btn"
              onClick={() => void act({ type: 'mark-done', attemptId: attempt.id, outputs: Object.fromEntries(Object.entries(fields).filter(([, v]) => v.trim()).map(([k, v]) => [k, { type: 'text' as const, text: v }])) })}
            >
              Mark done
            </button>
          </details>
        )}
      </div>
    )
  }
  if (attempt.state === 'failed' || attempt.state === 'interrupted') {
    return (
      <div className="workflow-actions">
        <button type="button" className="btn btn-solid" onClick={() => void act({ type: 'retry', step: step.key })} data-workflow-retry>
          Retry {step.kind === 'review' ? '' : 'on a new node'}
        </button>
      </div>
    )
  }
  return null
}

function RunPanel({ run, onClose }: { run: WorkflowRun; onClose: () => void }): React.JSX.Element {
  const flow = useReactFlow()
  const statuses = useStore((s) => s.statuses)
  const [problem, setProblem] = useState<string | null>(null)
  const act = async (a: PersonAction): Promise<void> => {
    setProblem(null)
    const r = await workflows.act(run.id, a)
    if (!r.ok) setProblem(r.reason)
  }
  const show = (id: string): void => void flow.fitView({ nodes: [{ id }], padding: safePadding(), maxZoom: 1, duration: 260 })
  const ended = run.state === 'succeeded' || run.state === 'stopped'
  return (
    <aside className="workflow-panel pop" aria-label={`Workflow run ${run.definition.name}`} data-workflow-panel={run.state}>
      <header className="workflow-panel-head">
        <div>
          <h2>{run.definition.name}</h2>
          {runSubject(run) && <p className="recipe-dim">{runSubject(run)}</p>}
        </div>
        <StatusPair look={workflowRunLook(run.state)} className={`workflow-state workflow-state-${run.state}`} />
        <button type="button" className="btn" aria-label="Close" onClick={onClose}>✕</button>
      </header>
      <p className="recipe-dim workflow-where">
        {run.worktree ? <>Branch <code>{run.worktree.branch}</code> in <code>{run.worktree.path}</code></> : <>In <code>{run.cwd}</code></>}
      </p>
      <ol className="workflow-run-steps">
        {run.definition.steps.map((s, n) => {
          const a = currentAttempt(run, s.key)
          const look = attemptLook(a?.state ?? 'pending', a?.idle)
          const outs = stepOutputs(s)
          return (
            <li key={s.key} className={`workflow-run-step workflow-run-step-${a?.state ?? 'pending'}`} data-workflow-run-step={s.key}>
              <div className="workflow-row">
                <span className="workflow-step-n">{n + 1}</span>
                <span className="recipe-node-title">{s.title}</span>
                <StatusPair look={look} className={`workflow-state workflow-state-${a?.state ?? 'pending'}`} />
                {a && a.n > 1 && <span className="recipe-dim">attempt {a.n}</span>}
                {a?.decidedBy && <span className="recipe-dim">by you</span>}
                {a?.nodeId && (
                  <button type="button" className="btn" onClick={() => show(a.nodeId!)}>
                    Show
                  </button>
                )}
              </div>
              {a?.why && a.state !== 'succeeded' && <p className="recipe-dim">{a.why}</p>}
              {a?.nodeId && (a.state === 'running' || a.state === 'launching') && statuses[a.nodeId] === 'needs-you' && (
                <p className="workflow-asks" data-workflow-asks>
                  Its agent is asking you something in its window, such as whether to trust the run's new folder. Show it to answer.
                </p>
              )}
              {a?.outputs && Object.keys(a.outputs).length > 0 && (
                <dl className="workflow-outputs">
                  {Object.entries(a.outputs).map(([k, v]) => (
                    <div key={k}>
                      <dt>{outs.find((o) => o.key === k)?.label ?? k}</dt>
                      <dd><Value value={v} /></dd>
                    </div>
                  ))}
                </dl>
              )}
              {a && currentAttempt(run, s.key)?.id === a.id && <StepActions run={run} attempt={a} act={act} />}
              {earlierAttempts(run, s.key).length > 0 && (
                <details className="workflow-history">
                  <summary>Earlier attempts</summary>
                  {earlierAttempts(run, s.key).map((x) => (
                    <p key={x.id} className="recipe-dim">
                      Attempt {x.n}: {ATTEMPT_LABEL[x.state]}{x.why ? ` — ${x.why}` : ''}
                    </p>
                  ))}
                </details>
              )}
            </li>
          )
        })}
      </ol>
      {problem && <p className="field-problem" role="alert">{problem}</p>}
      <p className="recipe-dim">Steps run while Patchbay is open (or in the tray). If it fully quits, steps in progress are checked when it opens again; nothing is taken as done without its result.</p>
      {!ended && (
        <div className="pop-actions">
          <button type="button" className="btn" onClick={() => void act({ type: 'stop' })} data-workflow-stop>
            Stop run
          </button>
        </div>
      )}
    </aside>
  )
}

/**
 * Workflow runs over the canvas: a chip for each run that's going or just ended, saying where it is, and the panel
 * for one. The engine runs in main; this only shows it and passes on the person's decisions.
 */
export function WorkflowLayer(): React.JSX.Element | null {
  const projectId = useStore((s) => s.doc?.activeProjectId)
  const panelRun = useWorkflowUi((s) => s.panelRun)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!projectId) return
    let live = true
    void workflows.runs(projectId).then((r) => live && setRuns(r))
    const off = workflows.onChange((run) => {
      if (run.projectId !== projectId) return
      setRuns((all) => [run, ...all.filter((r) => r.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt))
      setNow(Date.now())
    })
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      live = false
      off()
      clearInterval(t)
    }
  }, [projectId])

  const open = runs.find((r) => r.id === panelRun)
  const chips = chipRuns(runs, now)
  if (!chips.length && !open) return null
  return (
    <>
      {chips.length > 0 && (
        <div className="workflow-chips-bar" aria-label="Workflow runs">
          {chips.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`workflow-run-chip${needsPerson(r) ? ' workflow-run-chip-attn' : ''}${r.id === panelRun ? ' workflow-run-chip-on' : ''}`}
              data-workflow-chip={r.state}
              onClick={() => openRunPanel(r.id === panelRun ? null : r.id)}
            >
              <StatusMark look={workflowRunLook(r.state)} size={8} />
              <strong>Workflow: {r.definition.name}</strong>
              {runSubject(r) && <span className="recipe-dim"> — {runSubject(r)}</span>}
              <span className="workflow-strip">{runStrip(r)}</span>
            </button>
          ))}
        </div>
      )}
      {open && <RunPanel run={open} onClose={() => openRunPanel(null)} />}
    </>
  )
}
