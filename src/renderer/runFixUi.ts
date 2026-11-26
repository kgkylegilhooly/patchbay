import type { RunFixResult } from '../shared/runFix'
import { say } from './reader/readerUi'

declare global {
  interface Window {
    /** See src/preload/reply.ts. */
    patchbayRunFix?: { brief(nodeId: string): Promise<RunFixResult> }
  }
}

/** What opening the New agent form with a brief takes. App registers it, as the form is App's state. */
export type FixForm = (fix: { from: string; cwd: string; prompt: string }) => void

let openForm: FixForm | null = null

export function setRunFixForm(open: FixForm | null): void {
  openForm = open
}

/**
 * Ask an agent to fix (F31): the New agent form, in the run's folder, with a brief holding the command, the exit code
 * and the last output. Nothing starts until the person presses Open, and the new agent is linked to the run.
 */
export async function askToFixRun(nodeId: string): Promise<void> {
  const r = await window.patchbayRunFix?.brief(nodeId)
  if (!r) return
  if (!r.ok) return say(r.reason, false)
  openForm?.({ from: nodeId, cwd: r.cwd, prompt: r.brief })
}
