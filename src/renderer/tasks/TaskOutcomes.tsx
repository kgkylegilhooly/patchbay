import { useEffect, useState } from 'react'
import type { Task, TaskRecords, TaskState, TaskVerification, TaskView } from '../../shared/task'
import { bridge } from '../bridge'
import { useStore } from '../store'
import { openReviewInbox } from '../reviewInboxUi'
import { TaskComparisons, tryApproachesFor } from './TaskComparisons'
import './tasks.css'

/**
 * What a task's stored state is shown as. "ready-for-review" is stored when an agent submits, but files can change
 * after that, so on its own it only means submitted: whether it's still ready comes from a fresh readiness check.
 */
const STATE_LABEL: Record<TaskState, string> = {
  planned: 'planned',
  running: 'running',
  blocked: 'blocked',
  'ready-for-review': 'submitted',
  accepted: 'accepted',
  cancelled: 'cancelled'
}

export function SessionTaskOutcomes({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const projects = useStore((s) => s.doc?.projects)
  const tasks = projects?.flatMap((p) => p.tasks?.tasks.filter((t) => t.assignedSessionIds.includes(sessionId)) ?? []) ?? []
  if (!tasks.length) return null
  return <span className="task-session-outcomes">{tasks.map((task) => <span key={task.id} className={`task-state task-${task.state}`} title={`${task.brief}: ${STATE_LABEL[task.state]}. Task outcome is separate from agent status. Open the board to see whether it's still ready.`}>Task: {STATE_LABEL[task.state]}</span>)}</span>
}

/** Who declared the required checks, so checks an agent chose for itself are never read as the person's. */
function declaredBy(task: Task): string {
  const by = task.createdBy
  if (!by) return 'Declared when the task was made'
  if (by.kind === 'person') return 'Declared by you'
  const title = useStore.getState().doc?.nodes.find((n) => n.id === by.sessionId)?.title
  return `Declared by the agent${title ? ` "${title}"` : ''} that made this task. Check they test what you need`
}

function TaskCard({ task, records }: { task: Task; records: TaskRecords }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<TaskView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const attempts = records.attempts.filter((a) => a.taskId === task.id)
  const submission = attempts.find((a) => a.id === task.submissionId && a.kind === 'agent-report')
  const commands = attempts.filter((a): a is TaskVerification => a.kind === 'command')
  const refresh = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try { setView(await bridge.taskShow(task.projectId, task.id)) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  // Readiness is read fresh whenever the records change, so the card never says ready on the strength of an old state.
  useEffect(() => {
    if (task.state === 'cancelled') return
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records])
  const accept = async (): Promise<void> => {
    if (!view?.task.submissionId) return
    setBusy(true)
    setError('')
    try { await bridge.taskAccept(task.projectId, task.id, view.task.submissionId) }
    catch (e) { setError(String(e)); setView(null) }
    finally { setBusy(false) }
  }
  const latest = (checkId: string): TaskVerification | undefined => commands.filter((a) => !a.comparison && a.checkId === checkId).at(-1)
  return <article className="task-outcome-card" data-task={task.id}>
    <div className="task-card-heading"><strong>{task.brief}</strong><span className={`task-state task-${task.state}`}>{STATE_LABEL[task.state]}</span></div>
    {submission?.kind === 'agent-report' && <p><span className="task-evidence-label">Agent submission</span> {submission.summary}</p>}
    {task.requiredChecks.length > 0 && <div className="task-checks">
      <span className="task-evidence-label">Required checks · {declaredBy(task)}</span>
      <ul>{task.requiredChecks.map((c) => {
        const run = latest(c.id)
        return <li key={c.id} data-check={c.id}><strong>{c.id}</strong> <code>{c.command}</code> <span className={`task-check-${run?.status ?? 'none'}`}>{run ? `${run.status}${run.exitCode !== null ? `, exit ${run.exitCode}` : ''}` : 'not run'}</span></li>
      })}</ul>
    </div>}
    <TaskComparisons attempts={attempts} compact={!expanded} />
    {view && task.state !== 'cancelled' && task.state !== 'accepted' && <p className={view.readiness.ready ? 'task-ready' : 'task-blocked'} data-readiness={view.readiness.ready ? 'ready' : 'not-ready'}>
      {view.readiness.ready ? 'Ready for review now: the submission and every required check match the files as they are.' : `Not ready: ${view.readiness.reasons.join('; ')}`}
    </p>}
    {view && view.readiness.warnings.length > 0 && <p className="task-warning">{view.readiness.warnings.join('; ')}</p>}
    <div className="task-card-tools"><span>{commands.length} command {commands.length === 1 ? 'attempt' : 'attempts'}</span><span className="task-card-buttons">{task.state !== 'accepted' && task.state !== 'cancelled' && <button className="git-btn" data-try-approaches={task.id} title="Two attempts at this task, each in its own worktree. Their runs and your choice are recorded here" onClick={() => tryApproachesFor(task)}>Try two approaches…</button>}<button className="git-btn" disabled={busy} onClick={() => { setExpanded(true); void refresh() }}>{busy ? 'Checking…' : expanded ? 'Refresh evidence' : 'Review outcome'}</button></span></div>
    {expanded && <div className="task-details">
      <button className="git-mini" onClick={() => setExpanded(false)}>Hide details</button>
      <ul>{task.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
      {attempts.map((a) => <div className="task-attempt" key={a.id}>
        {a.kind === 'agent-report' ? <><strong>Agent self-report</strong><p>{a.summary}</p></> : a.kind === 'comparison' ? <>
          <strong>Comparison attempt {a.key.toUpperCase()}{a.chosen ? ' · chosen by you' : ''}</strong>
          <span>{a.title} · branch <code>{a.branch}</code> in {a.path}</span><span>Started {new Date(a.startedAt).toLocaleString()} from {a.base.slice(0, 10)}</span>
        </> : a.kind === 'browser' ? <>
          <strong>Browser check · {a.state === 'recording' ? 'recording' : a.state === 'incomplete' ? 'incomplete' : 'recorded'} · agent says {a.state === 'recording' ? '—' : a.assertion}</strong>
          <span>{a.url}</span><span>{new Date(a.startedAt).toLocaleString()} → {a.endedAt ? new Date(a.endedAt).toLocaleString() : 'recording'}</span>
          <span>The agent's claim, not proof. {a.gaps ? `${a.gaps} ${a.gaps === 1 ? 'gap' : 'gaps'} reported. ` : ''}Pictures and diagnostics are in the browser node's Evidence panel.</span>
        </> : <>
          <strong>Executed command{a.comparison ? ` · comparison attempt ${a.comparison.key.toUpperCase()}, in its worktree` : ''} · {a.status}{a.exitCode !== null ? ` · exit ${a.exitCode}` : ''}</strong><code>{a.command}</code>
          <span>{a.cwd}</span><span>{new Date(a.startedAt).toLocaleString()} → {a.endedAt ? new Date(a.endedAt).toLocaleString() : 'running'}</span>
          <code title="Saved command output">Output: {a.outputRef}</code>{a.error && <span>{a.error}</span>}
        </>}
        <code>Revision: {a.revision.noRepo ? 'not a git repository' : a.revision.revision ?? `unknown${a.revision.reason ? ` (${a.revision.reason})` : ''}`} · uncommitted: {a.revision.uncommitted === null ? 'unknown' : a.revision.uncommitted ? 'yes' : 'no'}</code>
      </div>)}
      {task.acceptances.map((a, i) => <p key={i}>Accepted by you on {new Date(a.at).toLocaleString()} (submission {a.submissionId}).</p>)}
    </div>}
    {task.state !== 'accepted' && task.state !== 'cancelled' && <button className="git-btn git-btn-main" disabled={busy || !view?.readiness.ready} onClick={() => void accept()}>Accept this submission</button>}
    {error && <p role="alert">{error}</p>}
  </article>
}

export function TaskOutcomes({ records }: { records?: TaskRecords }): React.JSX.Element | null {
  if (!records?.tasks.length) return null
  return <section className="task-outcomes" aria-label="Task outcomes"><h3>Task outcomes <span>{records.tasks.length}</span> <button className="git-mini" data-cmd="review-inbox" onClick={() => openReviewInbox()}>Review inbox</button></h3><div className="task-outcome-list">{records.tasks.map((task) => <TaskCard key={task.id} task={task} records={records} />)}</div></section>
}
