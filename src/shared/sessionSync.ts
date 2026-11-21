import type { AgentStatus } from './model'

/**
 * Keeping the canvas, the app's copy of each session and the background host in agreement. See
 * docs/plans/session-sync.md and src/main/sessions/sessionSync.ts.
 */

/** What a check found wrong with one session, or null when the node and the host agree. */
export type SyncProblem =
  /** Running in the host with no node on the canvas, so nothing shows it. Never ended without asking. */
  | 'orphan'
  /** The canvas said it had ended while the host still ran it. Shown again. */
  | 'shown-exited'
  /** Counted as running, but its process is gone. Marked as ended. */
  | 'pid-gone'
  /** Its status had said starting or working long after its hooks went quiet, with the program waiting at its prompt. */
  | 'stale-status'

export interface SyncRow {
  id: string
  /** The node's title, or null for a session with no node. */
  title: string | null
  kind: string | null
  running: boolean
  pid: number | null
  /** Whether that process is there. Null when it isn't running. */
  alive: boolean | null
  /** The status the canvas shows, for an agent or an ended terminal. */
  shown: AgentStatus | null
  problem: SyncProblem | null
}

export interface SyncReport {
  at: number
  /** False when there was no background host to ask, as when sessions run in the app. */
  hostReached: boolean
  rows: SyncRow[]
}

/** Restart found the session still running, so it was shown again instead. Its notice offers ending it first. */
export interface JoinedRefusal {
  ok: false
  reason: string
  joined: true
}

export const JOINED_NOTICE = 'This session was still running in the background, so it is shown again instead of starting a second one.'

/** `window.patchbaySync`. Served in src/main/sessionSyncIpc.ts. */
export interface SessionSyncBridge {
  /** The last check, or null before the first. */
  report(): Promise<SyncReport | null>
  /** Checks now, whenever the last check was. */
  check(): Promise<SyncReport>
  onReport(cb: (report: SyncReport) => void): () => void
  /** A session the canvas had shown as ended turned out to be running, and is shown again. */
  onJoined(cb: (id: string) => void): () => void
  /** Ends the session's whole process tree, then starts it again: an agent resumes its conversation. */
  endAndRestart(id: string): Promise<void>
  /** Ends a session that has no node. */
  endOrphan(id: string): Promise<void>
  /** Gives a session that has no node a terminal node of its own, showing it. */
  adoptOrphan(id: string): Promise<void>
}
