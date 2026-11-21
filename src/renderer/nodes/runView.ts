import type { RunResult } from '../../shared/contract'
import { runLook } from '../status/status'

export { runFailed } from '../status/status'

/** "Running", "Exited 1": the same words the status system gives a run everywhere. */
export function runLabel(run: RunResult | undefined): string {
  return runLook(run).label
}
