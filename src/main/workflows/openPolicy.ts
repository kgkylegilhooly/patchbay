import { isRunnable } from '../shellActions'

/**
 * How Open treats a workflow's file: a file Windows would run (an agent may submit `plan.hta` or `report.lnk`) is only
 * shown in its folder; anything else opens with the app for it. Clicking "Plan document" must never run a program.
 */
export function openAction(path: string): 'reveal' | 'open' {
  return isRunnable(path) ? 'reveal' : 'open'
}
