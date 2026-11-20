import { useMemo, useRef, useState } from 'react'
import { stepOutputs, workflowIssues, type AgentStep, type CommandStep, type InputSpec, type ReviewStep, type Step, type StepKind, type Workflow } from '../../shared/workflow'
import { AGENT_NAMES } from '../../shared/model'
import { workflows } from '../workflowBridge'
import {
  addInput, addStep, choicesFor, chipsIn, insertAt, moveStep, removeInput, removeStep, updateInput, updateStep, usesOfInput, usesOfStep, type Choice
} from './editModel'
import { chooseWorkflow, editWorkflow, loadWorkflows, useWorkflowUi, type Editing } from './workflowUi'

const KIND_LABEL: Record<StepKind, string> = { agent: 'Agent task', command: 'Run command', review: 'Your review' }

/** A picker of what a step can use, as "Plan › Plan document". Choosing inserts it; there's nothing to type. */
function ValuePicker({ choices, onPick, label = 'Insert value…', only }: { choices: Choice[]; onPick: (c: Choice) => void; label?: string; only?: Array<Choice['type']> }): React.JSX.Element {
  const usable = only ? choices.filter((c) => only.includes(c.type)) : choices
  return (
    <select
      className="workflow-value-picker"
      value=""
      aria-label={label}
      disabled={!usable.length}
      onChange={(e) => {
        const c = usable.find((x) => x.token === e.target.value)
        if (c) onPick(c)
      }}
    >
      <option value="">{usable.length ? label : 'No values to use yet'}</option>
      {usable.map((c) => <option key={c.token} value={c.token}>{c.label}</option>)}
    </select>
  )
}

function Chips({ wf, step, text }: { wf: Workflow; step: string; text: string }): React.JSX.Element | null {
  const chips = chipsIn(wf, step, text)
  if (!chips.length) return null
  return (
    <span className="workflow-chips">
      Uses:{' '}
      {chips.map((c, i) => (
        <span key={c.token + i} className={`workflow-chip${c.known ? '' : ' workflow-chip-bad'}`} title={c.token}>
          {c.label}
        </span>
      ))}
    </span>
  )
}

function AgentDetails({ wf, step, set }: { wf: Workflow; step: AgentStep; set: (s: AgentStep) => void }): React.JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null)
  const choices = choicesFor(wf, step.key)
  return (
    <>
      <label className="field">
        <span className="field-label">Agent</span>
        <select value={step.agent} onChange={(e) => set({ ...step, agent: e.target.value as AgentStep['agent'] })}>
          <option value="claude">{AGENT_NAMES.claude}</option>
          <option value="codex">{AGENT_NAMES.codex}</option>
        </select>
      </label>
      <label className="field recipe-wide">
        <span className="field-label">Prompt</span>
        <textarea ref={area} rows={5} value={step.prompt} placeholder="What the agent should do. Insert values below." onChange={(e) => set({ ...step, prompt: e.target.value })} data-workflow-prompt />
      </label>
      <div className="workflow-row recipe-wide">
        <ValuePicker
          choices={choices}
          onPick={(c) => {
            const at = area.current?.selectionStart ?? step.prompt.length
            const r = insertAt(step.prompt, at, c.token)
            set({ ...step, prompt: r.text })
            requestAnimationFrame(() => area.current?.setSelectionRange(r.caret, r.caret))
          }}
        />
        <Chips wf={wf} step={step.key} text={step.prompt} />
      </div>
      <div className="field recipe-wide">
        <span className="field-label">Result fields the agent submits</span>
        {step.outputs.map((o, n) => {
          const uses = usesOfStep(wf, step.key, o.key)
          const setOut = (change: Partial<typeof o>): void => set({ ...step, outputs: step.outputs.map((x, i) => (i === n ? { ...x, ...change } : x)) })
          return (
            <div key={n} className="workflow-row workflow-output" data-workflow-output={o.key}>
              <input aria-label="Label" value={o.label ?? ''} placeholder="Label" onChange={(e) => setOut({ label: e.target.value || undefined })} />
              <input aria-label="Key" className="workflow-key" value={o.key} spellCheck={false} onChange={(e) => setOut({ key: e.target.value })} />
              <select aria-label="Type" value={o.type} onChange={(e) => setOut({ type: e.target.value as 'text' | 'file' })}>
                <option value="text">Text</option>
                <option value="file">File</option>
              </select>
              <label className="recipe-check">
                <input type="checkbox" checked={o.required !== false} onChange={(e) => setOut({ required: e.target.checked ? undefined : false })} /> Required
              </label>
              <button type="button" className="btn" title={uses.length ? `Used by ${uses.join(', ')}` : 'Remove'} onClick={() => set({ ...step, outputs: step.outputs.filter((_, i) => i !== n) })}>
                Remove
              </button>
              {uses.length > 0 && <span className="recipe-dim workflow-uses">Used by {uses.join(', ')}</span>}
            </div>
          )
        })}
        <button type="button" className="btn workflow-add" onClick={() => set({ ...step, outputs: [...step.outputs, { key: `field${step.outputs.length + 1}`, type: 'text' }] })}>
          Add field
        </button>
      </div>
      <Timeout value={step.timeoutMin} set={(timeoutMin) => set({ ...step, ...(timeoutMin ? { timeoutMin } : { timeoutMin: undefined }) })} />
    </>
  )
}

function Timeout({ value, set }: { value: number | undefined; set: (v: number | undefined) => void }): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">Time limit, minutes (optional)</span>
      <input type="number" min={1} value={value ?? ''} onChange={(e) => set(e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined)} />
    </label>
  )
}

function CommandDetails({ wf, step, set }: { wf: Workflow; step: CommandStep; set: (s: CommandStep) => void }): React.JSX.Element {
  const choices = choicesFor(wf, step.key)
  const [program = '', ...args] = step.run
  const setArgs = (next: string[]): void => set({ ...step, run: [program, ...next] })
  return (
    <>
      <label className="field">
        <span className="field-label">Program</span>
        <input value={program} spellCheck={false} placeholder="npm" onChange={(e) => set({ ...step, run: [e.target.value, ...args] })} data-workflow-program />
      </label>
      <label className="field">
        <span className="field-label">Folder, inside the run's (optional)</span>
        <input value={step.folder ?? ''} spellCheck={false} placeholder="." onChange={(e) => set({ ...step, ...(e.target.value ? { folder: e.target.value } : { folder: undefined }) })} />
      </label>
      <div className="field recipe-wide">
        <span className="field-label">Arguments, one per row (no shell: quotes and && mean nothing here)</span>
        {args.map((a, n) => (
          <div key={n} className="workflow-row" data-workflow-arg={n}>
            <input aria-label={`Argument ${n + 1}`} value={a} spellCheck={false} onChange={(e) => setArgs(args.map((x, i) => (i === n ? e.target.value : x)))} />
            <ValuePicker choices={choices} label="Use a value…" onPick={(c) => setArgs(args.map((x, i) => (i === n ? c.token : x)))} />
            <Chips wf={wf} step={step.key} text={a} />
            <button type="button" className="btn" onClick={() => setArgs(args.filter((_, i) => i !== n))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn workflow-add" onClick={() => setArgs([...args, ''])}>
          Add argument
        </button>
      </div>
      <Timeout value={step.timeoutMin} set={(timeoutMin) => set({ ...step, ...(timeoutMin ? { timeoutMin } : { timeoutMin: undefined }) })} />
      <label className="recipe-check recipe-wide">
        <input type="checkbox" checked={!!step.taskCheck} onChange={(e) => set({ ...step, ...(e.target.checked ? { taskCheck: true } : { taskCheck: undefined }) })} />
        <span>Also a check on the deliverable task</span>
      </label>
    </>
  )
}

function ReviewDetails({ wf, step, set }: { wf: Workflow; step: ReviewStep; set: (s: ReviewStep) => void }): React.JSX.Element {
  const choices = choicesFor(wf, step.key)
  const on = (c: Choice): boolean => step.show.some((b) => JSON.stringify(b) === JSON.stringify(c.binding))
  return (
    <>
      <label className="field recipe-wide">
        <span className="field-label">Question for you</span>
        <input value={step.question} onChange={(e) => set({ ...step, question: e.target.value })} />
      </label>
      <div className="field recipe-wide">
        <span className="field-label">Shows you</span>
        {choices.length === 0 && <p className="recipe-dim">Add inputs or earlier steps first.</p>}
        {choices.map((c) => (
          <label key={c.token} className="recipe-check">
            <input
              type="checkbox"
              checked={on(c)}
              onChange={(e) => set({ ...step, show: e.target.checked ? [...step.show, c.binding] : step.show.filter((b) => JSON.stringify(b) !== JSON.stringify(c.binding)) })}
            />
            <span>{c.label}</span>
          </label>
        ))}
        <p className="recipe-dim">Request changes goes to the last agent step it shows, which works again on the same node.</p>
      </div>
    </>
  )
}

function InputsEditor({ wf, set }: { wf: Workflow; set: (wf: Workflow) => void }): React.JSX.Element {
  return (
    <section aria-label="Inputs" className="workflow-inputs">
      <h3>Inputs: the form you fill in for each run</h3>
      {wf.inputs.map((i, n) => {
        const uses = usesOfInput(wf, i.key)
        const change = (c: Partial<InputSpec>): void => set(updateInput(wf, n, c))
        return (
          <div key={n} className="workflow-row workflow-input-row" data-workflow-input-edit={i.key}>
            <input aria-label="Label" value={i.label} placeholder="Label" onChange={(e) => change({ label: e.target.value })} />
            <input aria-label="Key" className="workflow-key" value={i.key} spellCheck={false} onChange={(e) => change({ key: e.target.value })} />
            <select aria-label="Type" value={i.type} onChange={(e) => change({ type: e.target.value as InputSpec['type'] })}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Yes/no</option>
              <option value="enum">Choice</option>
            </select>
            {i.type === 'enum' && (
              <input aria-label="Choices" value={(i.options ?? []).join(', ')} placeholder="a, b, c" onChange={(e) => change({ options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
            )}
            <input
              aria-label="Default"
              placeholder="Default"
              value={i.default === undefined ? '' : String(i.default)}
              onChange={(e) => {
                const v = e.target.value
                change({ default: v === '' ? undefined : i.type === 'number' ? Number(v) : i.type === 'boolean' ? v === 'true' : v })
              }}
            />
            <label className="recipe-check">
              <input type="checkbox" checked={i.required !== false} onChange={(e) => change({ required: e.target.checked ? undefined : false })} /> Required
            </label>
            <button type="button" className="btn" title={uses.length ? `Used by ${uses.join(', ')}` : 'Remove'} onClick={() => set(removeInput(wf, n))}>
              Remove
            </button>
            {uses.length > 0 && <span className="recipe-dim workflow-uses">Used by {uses.join(', ')}</span>}
          </div>
        )
      })}
      <button type="button" className="btn workflow-add" onClick={() => set(addInput(wf))}>
        Add input
      </button>
    </section>
  )
}

/**
 * The ordered outline editor: the run form's inputs, the steps as cards in order, and the chosen step's details.
 * Values are picked from what's available, never typed as expressions. A workflow with problems still saves; they're
 * listed, and it can't start until they're fixed.
 */
export function WorkflowEditor({ projectId, editing, onCancel }: { projectId: string; editing: Editing; onCancel: () => void }): React.JSX.Element {
  const [wf, setWf] = useState<Workflow>(editing.workflow)
  const [open, setOpen] = useState<string | null>(editing.workflow.steps[0]?.key ?? null)
  const [where, setWhere] = useState(editing.where)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const repo = useWorkflowUi((s) => s.repo)
  const issues = useMemo(() => workflowIssues(wf), [wf])
  const issuesFor = (key: string) => issues.filter((i) => i.step === key)

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    const r = await workflows.save({ projectId, workflow: wf, where, ...(editing.file ? { file: editing.file, overwrite: true } : {}) })
    setBusy(false)
    if (!r.ok) {
      setProblem(r.reason)
      return
    }
    await loadWorkflows(projectId)
    const ref = `${where}:${wf.name}`
    const listed = useWorkflowUi.getState().entries?.find((e) => e.file === r.file)
    editWorkflow(null)
    chooseWorkflow(listed?.ref ?? ref)
  }

  const setStep = (key: string) => (s: Step): void => setWf((w) => updateStep(w, key, () => s))

  return (
    <div className="recipe-preview workflow-editor" data-workflow-editor>
      <header className="recipe-head">
        <h2>{editing.file ? 'Edit workflow' : 'New workflow'}</h2>
        {editing.file && <code className="recipe-file" title={editing.file}>{editing.file}</code>}
      </header>
      <div className="recipe-params">
        <label className="field recipe-wide">
          <span className="field-label">Name</span>
          <input value={wf.name} autoFocus placeholder="Feature" onChange={(e) => setWf({ ...wf, name: e.target.value })} data-workflow-name />
        </label>
        <label className="field recipe-wide">
          <span className="field-label">What it does (optional)</span>
          <input value={wf.description ?? ''} onChange={(e) => setWf({ ...wf, ...(e.target.value ? { description: e.target.value } : { description: undefined }) })} />
        </label>
        <label className="recipe-check recipe-wide">
          <input type="checkbox" checked={wf.worktree !== false} onChange={(e) => setWf({ ...wf, ...(e.target.checked ? { worktree: undefined } : { worktree: false }) })} />
          <span>Each run gets its own new worktree</span>
        </label>
      </div>

      <InputsEditor wf={wf} set={setWf} />

      <section aria-label="Steps">
        <h3>Steps, in order</h3>
        <ol className="workflow-cards">
          {wf.steps.map((s, n) => {
            const own = issuesFor(s.key)
            const isOpen = open === s.key
            return (
              <li key={s.key} className={`workflow-card${isOpen ? ' workflow-card-open' : ''}`} data-workflow-card={s.key}>
                <div className="workflow-card-head">
                  <button type="button" className="workflow-card-title" onClick={() => setOpen(isOpen ? null : s.key)} aria-expanded={isOpen}>
                    <span className="recipe-node-kind">{n + 1}. {s.kind === 'agent' ? AGENT_NAMES[s.agent] : KIND_LABEL[s.kind]}</span>
                    <span className="recipe-node-title">{s.title || s.key}</span>
                    {own.length > 0 && <span className="workflow-card-issues">{own.length} to fix</span>}
                    {stepOutputs(s).length > 0 && <span className="recipe-dim">→ {stepOutputs(s).map((o) => o.label || o.key).join(', ')}</span>}
                  </button>
                  <button type="button" className="btn" aria-label="Move up" disabled={n === 0} onClick={() => setWf(moveStep(wf, s.key, -1))}>↑</button>
                  <button type="button" className="btn" aria-label="Move down" disabled={n === wf.steps.length - 1} onClick={() => setWf(moveStep(wf, s.key, 1))}>↓</button>
                  <button
                    type="button"
                    className="btn"
                    title={usesOfStep(wf, s.key).length ? `Used by ${usesOfStep(wf, s.key).join(', ')}` : 'Delete'}
                    onClick={() => setWf(removeStep(wf, s.key))}
                  >
                    Delete
                  </button>
                </div>
                {isOpen && (
                  <div className="recipe-params workflow-details">
                    <label className="field recipe-wide">
                      <span className="field-label">Title</span>
                      <input value={s.title} onChange={(e) => setStep(s.key)({ ...s, title: e.target.value })} />
                    </label>
                    {s.kind === 'agent' && <AgentDetails wf={wf} step={s} set={setStep(s.key)} />}
                    {s.kind === 'command' && <CommandDetails wf={wf} step={s} set={setStep(s.key)} />}
                    {s.kind === 'review' && <ReviewDetails wf={wf} step={s} set={setStep(s.key)} />}
                    {own.map((i) => <p key={i.path + i.message} className="field-problem recipe-wide">{i.message}</p>)}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        <div className="workflow-row">
          <span className="recipe-dim">Add a step:</span>
          {(['agent', 'command', 'review'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="btn"
              data-workflow-add={k}
              onClick={() => {
                const r = addStep(wf, k)
                setWf(r.wf)
                setOpen(r.key)
              }}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Deliverable">
        <label className="recipe-check">
          <input type="checkbox" checked={!!wf.deliverable} onChange={(e) => setWf({ ...wf, ...(e.target.checked ? { deliverable: { criteria: ['It works'] } } : { deliverable: undefined }) })} />
          <span>Make a task for each run, to accept in the review inbox</span>
        </label>
        {wf.deliverable && (
          <label className="field">
            <span className="field-label">What it must do, one per line</span>
            <textarea rows={3} value={wf.deliverable.criteria.join('\n')} onChange={(e) => setWf({ ...wf, deliverable: { criteria: e.target.value.split('\n') } })} />
          </label>
        )}
      </section>

      {issues.filter((i) => !i.step).map((i) => <p key={i.path + i.message} className="recipe-dim">{i.message}</p>)}
      {issues.length > 0 && <p className="recipe-dim" data-workflow-issues={issues.length}>{issues.length} thing{issues.length === 1 ? '' : 's'} to fix before it can start. It can be saved as it is.</p>}
      {problem && <p className="field-problem" role="alert">{problem}</p>}
      <div className="pop-actions">
        {!editing.file && (
          <span className="workflow-where">
            Save to{' '}
            <label className="recipe-check">
              <input type="radio" name="workflow-where" checked={where === 'personal'} onChange={() => setWhere('personal')} /> Personal
            </label>
            {repo && (
              <label className="recipe-check">
                <input type="radio" name="workflow-where" checked={where === 'repository'} onChange={() => setWhere('repository')} /> Repository
              </label>
            )}
          </span>
        )}
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-solid" disabled={busy || !wf.name.trim()} onClick={() => void save()} data-workflow-save>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
