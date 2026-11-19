import { useShallow } from 'zustand/react/shallow'
import type { CanvasNode } from '../../shared/model'
import { recipes } from '../recipeBridge'
import { useStore } from '../store'

/**
 * On a recipe agent held for setup: which step it waits for and how that step is doing, or which one failed and why.
 * It starts by itself once every step exits with code 0. Start anyway skips the setup.
 */
export function SetupHold({ node }: { node: CanvasNode }): React.JSX.Element | null {
  const wait = node.kind === 'claude' ? node.setupWait : undefined
  const steps = useStore(
    useShallow((s) =>
      (Array.isArray(wait?.steps) ? wait.steps : []).map((id) => {
        const step = s.doc?.nodes.find((n) => n.id === id)
        const run = s.runs[id]
        const state = !step ? 'closed' : run?.running ? 'running' : run && run.exitCode !== null ? `exited with ${run.exitCode}` : 'not running'
        return `${step?.title ?? 'a closed step'} (${state})`
      })
    )
  )
  if (!wait) return null
  const failed = wait.failed
  // Nothing is running and nothing failed, as after the PC restarted mid-setup: the steps wait for the person.
  const idle = !failed && steps.length > 0 && steps.every((s) => s.endsWith('(not running)'))
  const why = !failed
    ? ''
    : failed.why === 'closed'
      ? `${failed.title} was closed before it succeeded.`
      : failed.why === 'stopped'
        ? `${failed.title} was stopped before it finished.`
        : `${failed.title} exited with code ${failed.exitCode ?? 'unknown'}.`
  const text = failed
    ? `Setup failed, so this agent hasn't started. ${why} Run that step again to retry.`
    : idle
      ? `Setup isn't running. Run ${steps.map((s) => s.replace(/ \(not running\)$/, '')).join(', ')} to continue; this agent starts when it succeeds.`
      : `Waiting for setup: ${steps.join(', ')}.`
  return (
    <div className={`strip ${failed ? 'strip-error' : 'strip-held'}`} role={failed ? 'alert' : undefined} data-setup-hold={failed ? 'failed' : idle ? 'idle' : 'waiting'}>
      <div className="strip-text">
        <span>{text}</span>
        <span className="setup-hold-source">From recipe {wait.recipe}</span>
      </div>
      <div className="strip-actions">
        <button className="btn nodrag" title={wait.after?.length ? 'Skips the setup. It still starts after the agents it waits for.' : 'Skips the setup and starts it now.'} onClick={() => void recipes.startAnyway(node.id)}>
          Start anyway
        </button>
      </div>
    </div>
  )
}
