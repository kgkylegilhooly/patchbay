import type { Task, TaskAttempt } from '../../shared/task'
import { taskComparisonBrief, taskComparisons } from '../../shared/taskCompare'
import { AGENT_NAMES, type AgentKind } from '../../shared/model'
import { openComparisons, openTryApproach } from '../compareUi'
import { closeReviewInbox } from '../reviewInboxUi'
import { useStore } from '../store'
import './tasks.css'

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '—')
const agentName = (agent: string): string => AGENT_NAMES[agent as AgentKind] ?? agent

/** The comparison sheet sits under the board and the review inbox, so both step aside for it. */
function showOverCanvas(): void {
  closeReviewInbox()
  useStore.setState({ boardOpen: false, maximized: null, focus: null })
}

/** Starts a comparison for this task: the start dialog with the task chosen and its brief and criteria filled in. */
export function tryApproachesFor(task: Task): void {
  showOverCanvas()
  openTryApproach({ source: task.cwd, brief: taskComparisonBrief(task), taskId: task.id })
}

/**
 * A task's comparisons, from its own records: each attempt with its latest verification run and whether the person
 * chose it. A run is shown as the command Patchbay ran, in that attempt's worktree; it never counts as a required
 * check. Choosing merges nothing and accepts nothing.
 */
export function TaskComparisons({ attempts, compact = false }: { attempts: TaskAttempt[]; compact?: boolean }): React.JSX.Element | null {
  const comparisons = taskComparisons(attempts)
  if (!comparisons.length) return null
  return (
    <div className="task-comparisons" aria-label="Comparisons for this task">
      <span className="task-evidence-label">Comparisons started for this task</span>
      {comparisons.map((c) => (
        <div key={c.comparisonId} className="task-comparison" data-task-comparison={c.comparisonId}>
          <div className="task-comparison-head">
            <strong>{c.title}</strong>
            <span className="task-dim">from {short(c.base)}</span>
            <button
              type="button"
              className="git-mini"
              onClick={() => {
                showOverCanvas()
                openComparisons(c.comparisonId)
              }}
            >
              Open comparison
            </button>
          </div>
          <ul>
            {c.attempts.map(({ record, run, runs }) => (
              <li key={record.id} data-comparison-attempt={record.key} data-chosen={record.chosen ? 'yes' : 'no'}>
                <span className="task-comparison-key">{record.key.toUpperCase()}</span>
                <span>{agentName(record.agent)}</span>
                <code>{record.branch}</code>
                {run ? (
                  <span className={`task-check-${run.status}`} title={`${run.command} in ${run.cwd}. Output: ${run.outputRef}`}>
                    ran <code>{run.command}</code>: {run.status}
                    {run.exitCode !== null ? `, exit ${run.exitCode}` : ''}
                    {runs > 1 ? ` (latest of ${runs})` : ''}
                  </span>
                ) : (
                  <span className="task-dim">not verified</span>
                )}
                {record.chosen && <span className="task-comparison-chosen">Chosen at {short(record.chosen.head)}</span>}
              </li>
            ))}
          </ul>
          {!compact && (
            <p className="task-dim">
              {c.chosen
                ? `You chose ${c.chosen.key.toUpperCase()}. Nothing was merged: merge ${c.chosen.branch} with Git yourself. These runs were in the attempts' worktrees, so they don't count as this task's required checks.`
                : "Runs were in each attempt's own worktree, so they don't count as this task's required checks. Choosing an attempt records it here and merges nothing."}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
