import { useMemo, useState } from 'react'
import { canonicalSpec, MAX_TRIGGER_PROMPT, type TriggerTarget } from '../core/trigger/arming'
import { describeSchedule, nextRuns, scheduleError } from '../core/trigger/schedule'
import type { TriggerNode, TriggerSchedule } from '../shared/model'
import { bridge } from './bridge'
import { draftOf, scheduleOf, type IntervalUnit, type ScheduleDraft } from './triggerView'

export interface TriggerFields {
  schedule: TriggerSchedule
  prompt: string
  targetId: string | null
}

function Upcoming({ schedule }: { schedule: TriggerSchedule }): React.JSX.Element | null {
  const now = Date.now()
  const times = nextRuns(schedule, now, now, 3)
  if (!times.length) return null
  return <p className="pop-note">Next: {times.map((t) => new Date(t).toLocaleString()).join(' · ')}</p>
}

/** Making or editing a trigger. It never arms: saving a change disarms it, and arming has its own step. */
export function TriggerForm({
  editing,
  targets,
  onCancel,
  onSave
}: {
  editing?: TriggerNode
  targets: TriggerTarget[]
  onCancel: () => void
  onSave: (fields: TriggerFields) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftOf(editing?.schedule ?? { type: 'interval', everyMs: 5 * 60_000 }, Date.now()))
  const [prompt, setPrompt] = useState(editing?.prompt ?? '')
  const [targetId, setTargetId] = useState<string | null>(editing?.targetId ?? null)
  const schedule = useMemo(() => scheduleOf(draft), [draft])
  const problem = scheduleError(schedule) ?? (prompt.length > MAX_TRIGGER_PROMPT ? 'The prompt is too long.' : null)
  const set = (patch: Partial<ScheduleDraft>): void => setDraft((d) => ({ ...d, ...patch }))

  return (
    <form
      className="pop pop-trigger"
      aria-label={editing ? 'Edit trigger' : 'New trigger'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        if (!problem) onSave({ schedule, prompt, targetId })
      }}
    >
      <p className="pop-note">
        {editing ? 'Saving a change disarms it, so it fires only after you arm it again.' : 'It starts disarmed. Nothing is sent until you arm it.'} It runs only while Patchbay is open.
      </p>
      <div className="field">
        <span className="field-label">When</span>
        <div className="trigger-when">
          <select name="scheduleType" value={draft.type} onChange={(e) => set({ type: e.target.value as ScheduleDraft['type'] })}>
            <option value="interval">Every…</option>
            <option value="cron">Cron</option>
            <option value="once">Once</option>
          </select>
          {draft.type === 'interval' && (
            <>
              <input name="amount" inputMode="decimal" aria-label="How often" value={draft.amount} onChange={(e) => set({ amount: e.target.value })} />
              <select name="unit" aria-label="Unit" value={draft.unit} onChange={(e) => set({ unit: e.target.value as IntervalUnit })}>
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </select>
            </>
          )}
          {draft.type === 'cron' && <input name="cron" aria-label="Cron expression" spellCheck={false} placeholder="min hour day month weekday" value={draft.expr} onChange={(e) => set({ expr: e.target.value })} />}
          {draft.type === 'once' && <input name="at" type="datetime-local" aria-label="When" value={draft.at} onChange={(e) => set({ at: e.target.value })} />}
        </div>
        {problem ? <p className="field-problem">{problem}</p> : <Upcoming schedule={schedule} />}
      </div>
      <label className="field">
        <span className="field-label">Prompt to send</span>
        <textarea name="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Sends to</span>
        <select name="target" value={targetId ?? ''} onChange={(e) => setTargetId(e.target.value || null)}>
          <option value="">Choose later, by dragging from its jack</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} ({t.kind === 'claude' ? 'Claude' : 'terminal'})
            </option>
          ))}
        </select>
      </label>
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-solid" disabled={!!problem}>
          {editing ? 'Save' : 'Add trigger'}
        </button>
      </div>
    </form>
  )
}

/** Shows exactly what arming agrees to. What's armed is this, as shown: if it changes meanwhile, arming is refused. */
export function ArmReview({ node, target, onClose }: { node: TriggerNode; target: TriggerTarget | undefined; onClose: () => void }): React.JSX.Element {
  const [shown] = useState(() => canonicalSpec(node))
  const [problem, setProblem] = useState<string | null>(null)
  const now = Date.now()
  const upcoming = nextRuns(node.schedule, now, now, 3)
  return (
    <form
      className="pop pop-trigger"
      aria-label="Arm trigger"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void bridge.armTrigger(node.id, shown).then((r) => (r.ok ? onClose() : setProblem(r.reason)))
      }}
    >
      <p className="pop-note">Arming lets this trigger type into another session by itself, while Patchbay is open. Check each part.</p>
      <dl className="arm-review">
        <dt>When</dt>
        <dd data-arm="schedule">
          {describeSchedule(node.schedule)}
          {upcoming.length > 0 && <span className="arm-next">Next: {upcoming.map((t) => new Date(t).toLocaleString()).join(' · ')}</span>}
        </dd>
        <dt>Sends to</dt>
        <dd data-arm="target">
          {target ? `${target.title}, a ${target.kind === 'claude' ? 'Claude session. It waits until Claude is idle' : 'terminal. It types straight in, if the terminal is running'}. In ${target.cwd}` : 'Nothing chosen'}
        </dd>
        <dt>Prompt</dt>
        <dd>
          <pre data-arm="prompt">{node.prompt}</pre>
        </dd>
      </dl>
      {problem && (
        <p className="field-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="pop-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-solid" name="arm">
          Arm
        </button>
      </div>
    </form>
  )
}
