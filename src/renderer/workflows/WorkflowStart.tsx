import { useEffect, useMemo, useState } from 'react'
import { checkInputValue, type InputSpec, type InputValue } from '../../shared/workflow'
import type { StepPreview, WorkflowEntry } from '../../shared/workflowBridge'
import { useAgentChoice } from '../agentChoice'
import { AGENT_NAMES, type AgentKind } from '../../shared/model'
import { workflows } from '../workflowBridge'
import { editWorkflow, loadWorkflows, openRunPanel } from './workflowUi'
import { RUN_STATE_LABEL, runSubject } from './runView'
import type { WorkflowRun } from '../../shared/workflow'

const SOURCE_LABEL = { 'built-in': 'Built-in', personal: 'Personal', repository: 'Repository' } as const
const KIND_LABEL = { agent: 'Agent', command: 'Command', review: 'Your review' } as const

/** A form value as typed, and as the run takes it. */
function valueOf(input: InputSpec, raw: string | boolean | undefined): InputValue | undefined {
  if (raw === undefined || raw === '') return undefined
  if (input.type === 'boolean') return raw === true
  if (input.type === 'number') return Number(raw)
  return String(raw)
}

function Field({ input, value, onChange, autoFocus }: { input: InputSpec; value: string | boolean | undefined; onChange: (v: string | boolean) => void; autoFocus?: boolean }): React.JSX.Element {
  const label = (
    <span className="field-label">
      {input.label || input.key}
      {input.required === false && <span className="workflow-optional"> (optional)</span>}
    </span>
  )
  if (input.type === 'boolean') {
    return (
      <label className="recipe-check" data-workflow-input={input.key}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span>{input.label || input.key}</span>
      </label>
    )
  }
  return (
    <label className={`field${input.type === 'text' ? ' recipe-wide' : ''}`} data-workflow-input={input.key}>
      {label}
      {input.type === 'enum' ? (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {input.required === false && <option value="">—</option>}
          {(input.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : input.type === 'number' ? (
        <input type="number" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <textarea rows={2} autoFocus={autoFocus} value={String(value ?? '')} placeholder={input.description ?? ''} onChange={(e) => onChange(e.target.value)} />
      )}
      {input.description && input.type !== 'text' && <span className="recipe-dim">{input.description}</span>}
    </label>
  )
}

/**
 * The run-input form a workflow's inputs make, with each step as it will run. Nothing runs until Start; a workflow
 * with problems shows them and can be opened in the editor to fix.
 */
export function WorkflowStart({ projectId, entry, onStart, onCancel }: { projectId: string; entry: WorkflowEntry; onStart: (r: { group: string }) => void; onCancel: () => void }): React.JSX.Element {
  const wf = entry.workflow
  const agents = useAgentChoice()
  const [form, setForm] = useState<Record<string, string | boolean>>({})
  const [steps, setSteps] = useState<StepPreview[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [history, setHistory] = useState<WorkflowRun[]>([])

  useEffect(() => {
    void workflows.runs(projectId).then((all) => setHistory(all.filter((r) => r.ref === entry.ref).slice(0, 8)))
  }, [projectId, entry.ref])

  // Defaults, fresh for each workflow.
  useEffect(() => {
    const init: Record<string, string | boolean> = {}
    for (const i of wf?.inputs ?? []) if (i.default !== undefined) init[i.key] = typeof i.default === 'boolean' ? i.default : String(i.default)
    setForm(init)
    setProblem(null)
  }, [entry.ref, entry.hash])

  const inputs = useMemo(() => {
    const out: Record<string, InputValue> = {}
    for (const i of wf?.inputs ?? []) {
      const v = valueOf(i, form[i.key])
      if (v !== undefined) out[i.key] = v
    }
    return out
  }, [form, wf])

  useEffect(() => {
    if (!wf || entry.problem) return
    const t = setTimeout(() => {
      void workflows.preview({ projectId, ref: entry.ref, inputs }).then((r) => setSteps(r.ok ? r.steps : []))
    }, 150)
    return () => clearTimeout(t)
  }, [projectId, entry.ref, entry.problem, wf, inputs])

  const missing = (wf?.inputs ?? []).filter((i) => i.required !== false && i.default === undefined && inputs[i.key] === undefined).map((i) => i.label || i.key)
  const wrong = (wf?.inputs ?? []).flatMap((i) => {
    const v = inputs[i.key]
    const why = v === undefined ? null : checkInputValue(i, v)
    return why ? [`${i.label || i.key} ${why}.`] : []
  })
  const agentsOff = [...new Set((wf?.steps ?? []).flatMap((s) => (s.kind === 'agent' && !agents.enabled.includes(s.agent) ? [s.agent] : [])))] as AgentKind[]
  const canStart = !!wf && !entry.problem && !busy && !missing.length && !wrong.length && !agentsOff.length

  const start = async (): Promise<void> => {
    if (!canStart) return
    setBusy(true)
    setProblem(null)
    const r = await workflows.start({ projectId, ref: entry.ref, ...(entry.hash ? { hash: entry.hash } : {}), inputs })
    setBusy(false)
    if (r.ok) {
      if (r.groupId) onStart({ group: r.groupId })
      void loadWorkflows(projectId)
    } else setProblem(r.problems && r.problems.length > 1 ? r.problems.join(' ') : r.reason)
  }

  const edit = (): void => {
    if (!wf) return
    if (entry.source === 'built-in') editWorkflow({ workflow: structuredClone(wf), where: 'personal' })
    else editWorkflow({ workflow: structuredClone(wf), where: entry.source, ...(entry.file ? { file: entry.file } : {}) })
  }

  return (
    <div className="recipe-preview workflow-start" data-workflow-start={entry.name}>
      <header className="recipe-head">
        <h2>{entry.name}</h2>
        <span className={`recipe-source recipe-source-${entry.source}`}>{SOURCE_LABEL[entry.source]}</span>
        {entry.file && <code className="recipe-file" title={entry.file}>{entry.file}</code>}
        {entry.description && <p className="recipe-dim">{entry.description}</p>}
      </header>
      <div className="workflow-head-actions">
        {wf && (
          <button type="button" className="btn" onClick={edit} data-workflow-edit>
            {entry.source === 'built-in' ? 'Copy and edit' : 'Edit'}
          </button>
        )}
        {entry.file && (
          <button type="button" className="btn" onClick={() => void workflows.openFile(entry.file!)}>
            Open definition file
          </button>
        )}
      </div>

      {entry.problem && (
        <div className="recipe-warning" role="alert">
          <p>This workflow can't be started yet:</p>
          {(entry.issues ?? [{ message: entry.problem, path: '' }]).map((i) => <p key={i.path + i.message}>{i.message}</p>)}
        </div>
      )}

      {wf && !entry.problem && (
        <>
          {wf.inputs.length > 0 && (
            <div className="recipe-params" aria-label="Inputs">
              {wf.inputs.map((i, n) => (
                <Field key={i.key} input={i} value={form[i.key]} autoFocus={n === 0} onChange={(v) => setForm((f) => ({ ...f, [i.key]: v }))} />
              ))}
            </div>
          )}
          {agentsOff.map((a) => (
            <p key={a} className="field-problem" role="alert">
              It uses {AGENT_NAMES[a]}, which is turned off in Settings &gt; Agents.
            </p>
          ))}

          <section aria-label="Steps">
            <h3>Runs these steps in order{wf.worktree !== false && <>, in a new worktree of its own</>}</h3>
            <ol className="recipe-nodes workflow-steps">
              {(steps.length ? steps : wf.steps.map((s) => ({ key: s.key, kind: s.kind, title: s.title }) as StepPreview)).map((s, n) => (
                <li key={s.key} className="recipe-node" data-workflow-step={s.key}>
                  <span className="recipe-node-kind">
                    {n + 1}. {s.kind === 'agent' && s.agent ? AGENT_NAMES[s.agent as AgentKind] : KIND_LABEL[s.kind]}
                  </span>
                  <span className="recipe-node-title">{s.title}</span>
                  {s.kind === 'command' && s.runs !== undefined && (
                    <span className="recipe-run-how">
                      <code>{s.runs}</code> with no shell, in <code>{s.folder === '.' ? 'the run folder' : s.folder}</code>. Goes on only if it exits with code 0.
                      {s.taskCheck && ' Also counts as a check on the deliverable task.'}
                    </span>
                  )}
                  {s.kind === 'review' && s.question && <span className="recipe-node-wait">Waits for you: {s.question}</span>}
                  {s.kind === 'agent' && s.prompt && (
                    <details className="recipe-prompt">
                      <summary>Prompt</summary>
                      <pre>{s.prompt}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
            <p className="recipe-dim">A step finishes only when its agent submits a result, its command exits, or you decide. An agent going idle never counts.</p>
            {wf.deliverable && (
              <p className="recipe-dim">
                Makes a task to accept in the review inbox when it finishes: {wf.deliverable.criteria.join('; ')}.
              </p>
            )}
          </section>
        </>
      )}
      {history.length > 0 && (
        <section aria-label="Recent runs">
          <h3>Recent runs</h3>
          <ul className="workflow-history-list">
            {history.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="workflow-link"
                  onClick={() => {
                    openRunPanel(r.id)
                    onCancel()
                  }}
                >
                  {new Date(r.startedAt).toLocaleString()} — {runSubject(r) || 'no inputs'}
                </button>{' '}
                <span className={`workflow-state workflow-state-${r.state}`}>{RUN_STATE_LABEL[r.state]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {problem && <p className="field-problem" role="alert">{problem}</p>}
      {!problem && missing.length > 0 && <p className="recipe-dim">Fill in {missing.join(', ')}.</p>}
      {wrong.map((w) => <p key={w} className="field-problem">{w}</p>)}
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-solid" disabled={!canStart} onClick={() => void start()} data-workflow-run>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  )
}
