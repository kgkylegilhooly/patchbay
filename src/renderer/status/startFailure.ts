import type { NodeError, StartFix } from '../../shared/contract'
import type { AgentStatus, CanvasNode } from '../../shared/model'
import type { Look } from './status'

/**
 * An agent that couldn't start (its program wasn't found, its folder is gone, Settings turned it off) used to look
 * like one that finished: a grey "Exited". It has its own look, "Couldn't start", held (a hollow red ring: the person
 * has to act), and is listed under Need attention. Pure, so it's tested without a page. See docs/plans/r3-start.md.
 */

/** The start error an agent is stopped on, or null. Only while it isn't running: a notice on a live one isn't one. */
export function startFailureOf(node: Pick<CanvasNode, 'kind'> | undefined, status: AgentStatus | null | undefined, error: NodeError | undefined): NodeError | null {
  return node?.kind === 'claude' ? failedStart(status, error) : null
}

/** The same for an agent's status and error alone, where only agents have a status, as in a status badge. */
export function failedStart(status: AgentStatus | null | undefined, error: NodeError | undefined): NodeError | null {
  // A failed resume has its own words and Restart is its fix. A queued agent's error is cleared when it starts.
  if (!error || error.code === 'resume-failed') return null
  return status === 'exited' ? error : null
}

/** The look of an agent that couldn't start, with what went wrong for the tooltip. */
export function startFailureLook(error: NodeError): Look {
  // Not a failure: it starts by itself once Windows has memory to give it.
  if (error.fix === 'memory') return { tone: 'waits', label: 'Waiting for memory', detail: `Waiting for memory
${error.message}` }
  return { tone: 'held', label: "Couldn't start", detail: `Couldn't start\n${error.message}` }
}

/** What the button on the node offers for a fix, by the error's kind. */
export const FIX_LABELS: Record<StartFix, string> = {
  agents: 'Open Settings › Agents',
  sessions: 'Open Settings › Background sessions',
  folder: 'Choose folder…',
  memory: 'Start now'
}

/** The Settings section each settings fix opens. */
export const FIX_SECTIONS: Record<Exclude<StartFix, 'folder' | 'memory'>, 'claude' | 'sessions'> = { agents: 'claude', sessions: 'sessions' }
