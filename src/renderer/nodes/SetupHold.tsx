import type { CanvasNode } from '../../shared/model'
import { recipes } from '../recipeBridge'
import { useStore } from '../store'

/**
 * On a recipe agent held for setup: which step it waits for and how that step is doing, or which one failed and why.
 * It starts by itself once every step exits with code 0. Start anyway overrides that.
 */
export function SetupHold({ node }: { node: CanvasNode }): React.JSX.Element | null {
  const wait = node.kind === 'claude' ? node.setupWait : undefined
  const steps = useStore((s) =>
    (wait?.steps ?? [])
      .map((id) => {
        const step = s.doc?.nodes.find((n) => n.id === id)
        const run = s.runs[id]
        const state = !step ? 'closed' : run?.running ? 'running' : run && run.exitCode !== null ? `exited with ${run.exitCode}` : 'not running'
        return `${step?.title ?? 'a closed step'} (${state})`
      })
      .join(', ')
  )
  if (!wait) return null
  const failed = wait.failed
  const why = !failed
    ? ''
    : failed.why === 'closed'
      ? `${failed.title} was closed before it succeeded.`
      : failed.why === 'stopped'
        ? `${failed.title} was stopped before it finished.`
        : `${failed.title} exited with code ${failed.exitCode ?? 'unknown'}.`
  return (
    <div className={`strip ${failed ? 'strip-error' : 'strip-held'}`} role={failed ? 'alert' : undefined} data-setup-hold={failed ? 'failed' : 'waiting'}>
      <div className="strip-text">
        <span>
          {failed ? `Setup failed, so this agent hasn't started. ${why} Run that step again to retry.` : `Waiting for setup: ${steps}.`}
        </span>
        <span className="setup-hold-source">From recipe {wait.recipe}</span>
      </div>
      <div className="strip-actions">
        <button className="btn nodrag" onClick={() => void recipes.startAnyway(node.id)}>
          Start anyway
        </button>
      </div>
    </div>
  )
}
