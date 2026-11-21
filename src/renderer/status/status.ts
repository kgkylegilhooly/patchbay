import type { RunResult } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import { stopHolds, stopLabel, type AgentStop } from '../../shared/agentStop'
import type { SubagentStatus } from '../../shared/subagents'
import type { AttemptState, RunState } from '../../shared/workflow'

/**
 * One status system. Everything that has a state, an agent, a run command, a subagent or a workflow step, is shown
 * as a look: a tone and a few words. The tone decides the colour and the shape of the mark, so every screen agrees,
 * and status never rests on hue alone. Pure, so it's tested without a page.
 *
 * - working: busy (solid amber)
 * - done: finished fine (solid green)
 * - needs: waiting on the person now (solid red, blinks; its label is a red pill)
 * - pending: queued or on its way (grey ring, slow pulse)
 * - unknown: Patchbay can't tell yet (grey dashed ring)
 * - held: stopped, and the person has to act (hollow red ring)
 * - waits: stopped, and it clears by itself, as at a usage limit (hollow amber ring)
 * - ended: over, nothing to do (small dim dot)
 * - none: has no status to report, as a terminal (small grey square)
 */
export type Tone = 'working' | 'done' | 'needs' | 'pending' | 'unknown' | 'held' | 'waits' | 'ended' | 'none'

export interface Look {
  tone: Tone
  label: string
  /** Longer text for a tooltip, such as what Claude said when it stopped. */
  detail?: string
}

/** The agent words. "Unknown" is never shown to people. */
export const AGENT_LABELS: Record<AgentStatus, string> = {
  queued: 'Queued',
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  exited: 'Exited',
  unknown: 'No status yet'
}

const AGENT_TONES: Record<AgentStatus, Tone> = {
  queued: 'pending',
  starting: 'pending',
  working: 'working',
  idle: 'done',
  'needs-you': 'needs',
  exited: 'ended',
  unknown: 'unknown'
}

/**
 * A stopped agent: a usage limit that resets by itself waits; anything the person has to clear, a failed login, a
 * billing problem, an error, or a limit already past its reset, is held.
 */
export function stopLook(stop: AgentStop, now: number): Look {
  const label = stopLabel(stop, now)
  const tone: Tone = stop.holds === 'reset' && stopHolds(stop, now) ? 'waits' : 'held'
  return { tone, label, detail: stop.message ? `${label}\n${stop.message}` : label }
}

/**
 * An agent's look. Null status is a terminal or other node with nothing to report. An agent whose turn ended on
 * StopFailure keeps the status `unknown`, so the stop, when known, says what happened instead.
 */
export function agentLook(status: AgentStatus | null | undefined, stop?: AgentStop, now = Date.now()): Look {
  if (status === 'unknown' && stop) return stopLook(stop, now)
  if (!status) return { tone: 'none', label: 'No status' }
  return { tone: AGENT_TONES[status], label: AGENT_LABELS[status] }
}

/** A run command: amber while it runs, green when it exited 0, a red ring when it failed, dim when stopped. */
export function runLook(run: RunResult | undefined): Look {
  if (!run) return { tone: 'none', label: 'Not running' }
  if (run.running) return { tone: 'working', label: 'Running' }
  if (run.stoppedByYou) return { tone: 'ended', label: 'Stopped' }
  if (run.exitCode === null) return { tone: 'ended', label: 'Exited' }
  return { tone: run.exitCode === 0 ? 'done' : 'held', label: `Exited ${run.exitCode}` }
}

export function runFailed(run: RunResult | undefined): boolean {
  return runLook(run).tone === 'held'
}

const SUBAGENT: Record<SubagentStatus, Look> = {
  running: { tone: 'working', label: 'Running' },
  done: { tone: 'done', label: 'Done' },
  failed: { tone: 'held', label: 'Failed' }
}

export function subagentLook(status: SubagentStatus): Look {
  return SUBAGENT[status]
}

const WORKFLOW_RUN: Record<RunState, Look> = {
  running: { tone: 'working', label: 'Running' },
  'waiting-for-you': { tone: 'needs', label: 'Needs you' },
  succeeded: { tone: 'done', label: 'Done' },
  failed: { tone: 'held', label: 'Failed' },
  stopped: { tone: 'ended', label: 'Stopped' },
  // Only an interrupted step leaves a run here, and it waits for the person to retry it.
  'needs-attention': { tone: 'held', label: 'Interrupted' }
}

export function workflowRunLook(state: RunState): Look {
  return WORKFLOW_RUN[state]
}

const ATTEMPT: Record<AttemptState | 'pending', Look> = {
  pending: { tone: 'pending', label: 'Not yet' },
  launching: { tone: 'pending', label: 'Starting' },
  running: { tone: 'working', label: 'Running' },
  'waiting-for-you': { tone: 'needs', label: 'Needs you' },
  succeeded: { tone: 'done', label: 'Done' },
  failed: { tone: 'held', label: 'Failed' },
  interrupted: { tone: 'held', label: 'Interrupted' },
  superseded: { tone: 'ended', label: 'Replaced' }
}

/** A workflow step's current attempt, or `pending` before it has one. An agent idle with no result needs you. */
export function attemptLook(state: AttemptState | 'pending', idle = false): Look {
  if (idle && state === 'waiting-for-you') return { tone: 'needs', label: 'Idle, no result' }
  return ATTEMPT[state]
}

/** The CSS token each tone paints with. */
export const TONE_TOKENS: Record<Tone, string> = {
  working: '--status-working',
  done: '--status-done',
  needs: '--status-needs',
  pending: '--status-quiet',
  unknown: '--status-quiet',
  held: '--status-needs',
  waits: '--status-working',
  ended: '--status-ended',
  none: '--status-quiet'
}

/** What status.css sets, for where there's no stylesheet to read, as in tests. */
export const TOKEN_FALLBACK: Record<string, string> = {
  '--status-working': '#ff9f43',
  '--status-done': '#34c759',
  '--status-needs': '#ff453a',
  '--status-quiet': '#8e8e96',
  '--status-ended': '#77777f',
  '--status-held-map': '#a8322b'
}

/** Most pressing first: the order the team lights and summaries list tones in. */
export const TONE_ORDER: Tone[] = ['needs', 'held', 'working', 'waits', 'pending', 'done', 'ended', 'unknown', 'none']
