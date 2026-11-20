import { useMemo, useState } from 'react'
import { canonicalSpec, MAX_TRIGGER_PROMPT, type TriggerTarget } from '../core/trigger/arming'
import { describeLimits, folderProblem, isEventSchedule, limitsError, limitsOf, PLACEHOLDERS, placeholderProblem, preflightText, projectRoots } from '../core/trigger/events'
import { describeSchedule, nextRuns, scheduleError } from '../core/trigger/schedule'
import type { TriggerLimits, TriggerNode, TriggerPreflight, TriggerSchedule } from '../shared/model'
import { bridge } from './bridge'
import { FormShell } from './shell/FormShell'
import { useStore } from './store'
import { draftOf, extrasDraftOf, extrasOf, scheduleOf, type ExtrasDraft, type IntervalUnit, type ScheduleDraft } from './triggerView'
import { upcomingText } from './upcomingText'
import './triggerEvents.css'

export interface TriggerFields {
  schedule: TriggerSchedule
  prompt: string
  targetId: string | null
  preflight: TriggerPreflight | null
  limits: TriggerLimits | undefined
}

function Upcoming({ schedule }: { schedule: TriggerSchedule }): React.JSX.Element | null {
  const now = Date.now()
  const times = nextRuns(schedule, now, now, 3)
  if (!times.length) return null
  return <p className="pop-note">Next: {upcomingText(times, now)}</p>
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
  const doc = useStore((s) => s.doc)
  const projectId = editing?.projectId ?? doc?.activeProjectId
  const projectFolder = doc?.projects.find((p) => p.id === projectId)?.folder ?? ''
  const agents = useMemo(() => (doc?.nodes ?? []).filter((n) => n.kind === 'claude' && n.projectId === projectId), [doc, projectId])
  const runNodes = useMemo(() => (doc?.nodes ?? []).filter((n) => n.kind === 'run' && n.projectId === projectId), [doc, projectId])
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftOf(editing?.schedule ?? { type: 'interval', everyMs: 5 * 60_000 }, Date.now(), projectFolder))
  const [extras, setExtras] = useState<ExtrasDraft>(() => extrasDraftOf(editing, projectFolder))
  const [prompt, setPrompt] = useState(editing?.prompt ?? '')
  const [targetId, setTargetId] = useState<string | null>(editing?.targetId ?? null)
  /** What's missing from "When" shows once Create has been tried, not as soon as a kind is picked. */
  const [tried, setTried] = useState(false)
  const schedule = useMemo(() => scheduleOf(draft), [draft])
  const { preflight, limits, problem: commandProblem } = extrasOf(extras, schedule)
  const event = isEventSchedule(schedule)
  const roots = doc ? projectRoots(doc, projectId) : []
  const whenProblem = scheduleError(schedule) ?? (schedule.type === 'files' ? folderProblem(schedule.folder, roots, 'it watches') : null)
  const checkProblem = commandProblem ?? (preflight ? folderProblem(preflight.cwd, roots, 'the check runs in') : null)
  const limitsProblem = limitsError(limits)
  const promptProblem = placeholderProblem(prompt, schedule) ?? (prompt.length > MAX_TRIGGER_PROMPT ? 'The prompt is too long.' : null)
  const problem = whenProblem ?? promptProblem ?? checkProblem ?? limitsProblem
  const title = editing ? 'Edit trigger' : 'New trigger'
  const set = (patch: Partial<ScheduleDraft>): void => setDraft((d) => ({ ...d, ...patch }))
  const setX = (patch: Partial<ExtrasDraft>): void => setExtras((d) => ({ ...d, ...patch }))

  return (
    <FormShell
      title={title}
      icon="trigger"
      className="pop-trigger"
      onCancel={onCancel}
      blocked={!!problem && (tried || !whenProblem)}
      submitLabel={editing ? 'Save' : 'Create trigger'}
      onSubmit={() => {
        setTried(true)
        if (!problem) onSave({ schedule, prompt, targetId, preflight, limits })
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
            <option value="agent">An agent…</option>
            <option value="run">A run node…</option>
            <option value="files">Files change…</option>
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
          {draft.type === 'agent' && (
            <>
              <select name="agent" aria-label="Agent" value={draft.agentId} onChange={(e) => set({ agentId: e.target.value })}>
                <option value="">Choose an agent</option>
                {agents.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
              <select name="agentOn" aria-label="What happens" value={draft.agentOn} onChange={(e) => set({ agentOn: e.target.value as ScheduleDraft['agentOn'] })}>
                <option value="turn">finishes a turn</option>
                <option value="needs-you">needs you</option>
                <option value="exit">exits</option>
              </select>
            </>
          )}
          {draft.type === 'run' && (
            <select name="runNode" aria-label="Run node" value={draft.runId} onChange={(e) => set({ runId: e.target.value })}>
              <option value="">Choose a run node</option>
              {runNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          )}
        </div>
        {draft.type === 'run' && (
          <label className="trigger-check">
            <input type="checkbox" name="failedOnly" checked={draft.failedOnly} onChange={(e) => set({ failedOnly: e.target.checked })} /> Only when it fails (exits non-zero)
          </label>
        )}
        {draft.type === 'files' && (
          <div className="trigger-files">
            <input name="folder" aria-label="Folder to watch" spellCheck={false} placeholder="Folder inside the project" value={draft.folder} onChange={(e) => set({ folder: e.target.value })} />
            <div className="trigger-when">
              <input name="glob" aria-label="Files matching" spellCheck={false} placeholder="**/*.ts" value={draft.glob} onChange={(e) => set({ glob: e.target.value })} />
              <span className="trigger-unit">after</span>
              <input name="quiet" className="trigger-num" inputMode="decimal" aria-label="Seconds of quiet" value={draft.quietSeconds} onChange={(e) => set({ quietSeconds: e.target.value })} />
              <span className="trigger-unit">s quiet</span>
            </div>
            <p className="pop-note">.git and node_modules are never watched. A pattern without / matches file names at any depth.</p>
          </div>
        )}
        {whenProblem ? tried && <p className="field-problem">{whenProblem}</p> : event ? null : <Upcoming schedule={schedule} />}
      </div>
      <label className="field">
        <span className="field-label">Prompt to send</span>
        <textarea name="prompt" rows={4} autoFocus={!editing} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        {isEventSchedule(schedule) && (
          <span className="pop-note" data-trigger="placeholders">
            Can use {PLACEHOLDERS[schedule.type].map((p) => `{{${p}}}`).join(' ')}. Write \{'{{'} for a literal {'{{'}.
          </span>
        )}
        {promptProblem && <p className="field-problem">{promptProblem}</p>}
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
        {draft.type === 'files' && targets.find((t) => t.id === targetId)?.kind === 'terminal' && (
          <span className="pop-note" data-trigger="terminal-loop">
            Changes made while the terminal is still printing what it typed (plus the quiet time, up to 10 minutes) don't fire it again. To be sure, match only your sources, such as src/**, not build output.
          </span>
        )}
      </label>
      <div className="field">
        <span className="field-label">Only if this succeeds (optional)</span>
        <div className="trigger-when">
          <input name="preflight" aria-label="Check command" spellCheck={false} placeholder="npm test" value={extras.command} onChange={(e) => setX({ command: e.target.value })} />
        </div>
        {extras.command.trim() && (
          <label className="trigger-when">
            <span className="trigger-unit">Runs in</span>
            <input name="preflightCwd" aria-label="Folder the check runs in" spellCheck={false} value={extras.cwd} onChange={(e) => setX({ cwd: e.target.value })} />
          </label>
        )}
        {checkProblem ? <p className="field-problem">{checkProblem}</p> : <span className="pop-note">Runs without a shell before each firing. It fires only if this exits 0.</span>}
      </div>
      {event && (
        <div className="field">
          <span className="field-label">Limits</span>
          <div className="trigger-when">
            <span className="trigger-unit">At most once every</span>
            <input name="gap" className="trigger-num" inputMode="decimal" aria-label="Seconds between firings" value={extras.gapSeconds} onChange={(e) => setX({ gapSeconds: e.target.value })} />
            <span className="trigger-unit">seconds and</span>
            <input name="perHour" className="trigger-num" inputMode="numeric" aria-label="Firings per hour" value={extras.perHour} onChange={(e) => setX({ perHour: e.target.value })} />
            <span className="trigger-unit">times an hour</span>
          </div>
          {limitsProblem && <p className="field-problem">{limitsProblem}</p>}
        </div>
      )}
    </FormShell>
  )
}

/** Shows exactly what arming agrees to. What's armed is this, as shown: if it changes meanwhile, arming is refused. */
export function ArmReview({ node, target, onClose }: { node: TriggerNode; target: TriggerTarget | undefined; onClose: () => void }): React.JSX.Element {
  const [shown] = useState(() => canonicalSpec(node))
  const [problem, setProblem] = useState<string | null>(null)
  const nodes = useStore((s) => s.doc?.nodes)
  const now = Date.now()
  const upcoming = nextRuns(node.schedule, now, now, 3)
  const limits = limitsOf(node)
  const name = (id: string): string | undefined => nodes?.find((n) => n.id === id)?.title
  return (
    <FormShell
      title="Arm trigger"
      icon="trigger"
      className="pop-trigger"
      onCancel={onClose}
      hint={false}
      submitLabel="Arm"
      submitAttrs={{ name: 'arm' }}
      onSubmit={() => void bridge.armTrigger(node.id, shown).then((r) => (r.ok ? onClose() : setProblem(r.reason)))}
    >
      <p className="pop-note">Arming lets this trigger type into another session by itself, while Patchbay is open. Check each part.</p>
      <dl className="arm-review">
        <dt>When</dt>
        <dd data-arm="schedule">
          {describeSchedule(node.schedule, name)}
          {upcoming.length > 0 && <span className="arm-next">Next: {upcomingText(upcoming, now)}</span>}
        </dd>
        {node.preflight && (
          <>
            <dt>Only if</dt>
            <dd data-arm="preflight">
              <code>{preflightText(node.preflight)}</code> exits 0, run in {node.preflight.cwd}
            </dd>
          </>
        )}
        {limits && (
          <>
            <dt>Limits</dt>
            <dd data-arm="limits">
              {describeLimits(limits)}.{(node.schedule.type === 'files' || (node.schedule.type === 'agent' && node.schedule.nodeId === node.targetId)) && ' What happens in a turn its own prompt started never fires it again.'}
            </dd>
          </>
        )}
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
    </FormShell>
  )
}
