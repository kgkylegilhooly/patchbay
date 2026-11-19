import { useEffect, useState } from 'react'
import type { Task, TaskRecords, TaskView } from '../../shared/task'
import { bridge } from '../bridge'
import { useStore } from '../store'
import './tasks.css'

export function SessionTaskOutcomes({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const projects = useStore((s) => s.doc?.projects)
  const tasks = projects?.flatMap((p) => p.tasks?.tasks.filter((t) => t.assignedSessionIds.includes(sessionId)) ?? []) ?? []
  if (!tasks.length) return null
  return <span className="task-session-outcomes">{tasks.map((task) => <span key={task.id} className={`task-state task-${task.state}`} title={`${task.brief}: ${task.state}. Task outcome is separate from agent status.`}>Task: {task.state.replaceAll('-', ' ')}</span>)}</span>
}

function TaskCard({ task, records }: { task: Task; records: TaskRecords }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<TaskView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const attempts = records.attempts.filter((a) => a.taskId === task.id)
  const submission = attempts.find((a) => a.id === task.submissionId && a.kind === 'agent-report')
  const commands = attempts.filter((a) => a.kind === 'command')
  useEffect(() => { setView(null) }, [records])
  const inspect = async (): Promise<void> => {
    setExpanded(true)
    setBusy(true)
    setError('')
    try { setView(await bridge.taskShow(task.projectId, task.id)) }
    catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const accept = async (): Promise<void> => {
    if (!view?.task.submissionId) return
    setBusy(true)
    setError('')
    try { await bridge.taskAccept(task.projectId, task.id, view.task.submissionId) }
    catch (e) { setError(String(e)); setView(null) }
    finally { setBusy(false) }
  }
  return <article className="task-outcome-card" data-task={task.id}>
    <div className="task-card-heading"><strong>{task.brief}</strong><span className={`task-state task-${task.state}`}>{task.state.replaceAll('-', ' ')}</span></div>
    {submission?.kind === 'agent-report' && <p><span className="task-evidence-label">Agent submission</span> {submission.summary}</p>}
    <div className="task-card-tools"><span>{commands.length} command {commands.length === 1 ? 'attempt' : 'attempts'} · {task.requiredChecks.length} required {task.requiredChecks.length === 1 ? 'check' : 'checks'}</span><button className="git-btn" disabled={busy} onClick={() => void inspect()}>{busy ? 'Checking…' : expanded ? 'Refresh evidence' : 'Review outcome'}</button></div>
    {expanded && <div className="task-details">
      <button className="git-mini" onClick={() => setExpanded(false)}>Hide details</button>
      <ul>{task.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
      {view && <p className={view.readiness.ready ? 'task-ready' : 'task-blocked'}>{view.readiness.ready ? 'Current submission and required checks are ready for review.' : view.readiness.reasons.join('; ')}</p>}
      {attempts.map((a) => <div className="task-attempt" key={a.id}>
        {a.kind === 'agent-report' ? <><strong>Agent self-report</strong><p>{a.summary}</p></> : <>
          <strong>Executed command · {a.status}{a.exitCode !== null ? ` · exit ${a.exitCode}` : ''}</strong><code>{a.command}</code>
          <span>{a.cwd}</span><span>{new Date(a.startedAt).toLocaleString()} → {a.endedAt ? new Date(a.endedAt).toLocaleString() : 'running'}</span>
          <code title="Saved command output">Output: {a.outputRef}</code>{a.error && <span>{a.error}</span>}
        </>}
        <code>Revision: {a.revision.revision ?? 'unknown'} · uncommitted: {a.revision.uncommitted === null ? 'unknown' : a.revision.uncommitted ? 'yes' : 'no'}</code>
      </div>)}
      {task.acceptances.map((a, i) => <p key={i}>Accepted by you on {new Date(a.at).toLocaleString()} (submission {a.submissionId}).</p>)}
      {task.state !== 'accepted' && task.state !== 'cancelled' && <button className="git-btn git-btn-main" disabled={busy || !view?.readiness.ready} onClick={() => void accept()}>Accept this submission</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </article>
}

export function TaskOutcomes({ records }: { records?: TaskRecords }): React.JSX.Element | null {
  if (!records?.tasks.length) return null
  return <section className="task-outcomes" aria-label="Task outcomes"><h3>Task outcomes <span>{records.tasks.length}</span></h3><div className="task-outcome-list">{records.tasks.map((task) => <TaskCard key={task.id} task={task} records={records} />)}</div></section>
}
