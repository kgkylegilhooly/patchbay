import type { RunResult } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'

/** The colored dot, reusing the status colors: green while running, red for a failure, grey otherwise. */
export function runDot(run: RunResult | undefined): AgentStatus {
  if (run?.running) return 'idle'
  return runFailed(run) ? 'needs-you' : 'exited'
}

export function runFailed(run: RunResult | undefined): boolean {
  return !!run && !run.running && !run.stoppedByYou && run.exitCode !== null && run.exitCode !== 0
}

export function runLabel(run: RunResult | undefined): string {
  if (!run) return 'Not running'
  if (run.running) return 'Running'
  if (run.stoppedByYou) return 'Stopped'
  return `Exited ${run.exitCode ?? ''}`.trim()
}
