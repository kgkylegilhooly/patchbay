/**
 * Which conversation a Claude window is in, learned from any of its hooks. SessionStart normally says, but it's the one
 * hook that still runs as a command (Claude has no http form for it), so on a busy or short-of-memory PC it can be lost
 * while every later event, posted to the session host, arrives carrying the same `session_id` and `transcript_path`.
 * A window whose SessionStart was lost showed "no conversation yet" for its whole life, and sends to it couldn't be
 * confirmed. See docs/plans/r2-reliability.md.
 *
 * Careful about what may move a window to another session:
 * - Never SessionEnd (the ending session, as on /clear), nor a subagent's own events.
 * - A tool call or a prompt can come from inside a subagent, so those only fill in what's missing.
 * - A turn of the main conversation (UserPromptSubmit, Stop, StopFailure) can move it: that's a /clear or resume whose
 *   SessionStart was lost.
 * - Codex windows are left alone: a child thread's hooks carry the child's session.
 * SessionStart itself is handled where it always was.
 */

export interface KnownSession {
  sessionId: string | null
  transcriptPath: string | null
  agent?: string
}

export interface LearnedSession {
  sessionId: string
  transcriptPath: string | null
}

const NEVER = new Set(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop'])
const MAIN_TURN = new Set(['UserPromptSubmit', 'Stop', 'StopFailure'])

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Pure. What to record for the window, or null when the event changes nothing or can't be trusted to. */
export function sessionFromHook(known: KnownSession, payload: Record<string, unknown>): LearnedSession | null {
  if ((known.agent ?? 'claude') !== 'claude') return null
  const name = text(payload.hook_event_name)
  if (!name || NEVER.has(name)) return null
  const sessionId = text(payload.session_id)
  if (!sessionId) return null
  const transcriptPath = text(payload.transcript_path)
  const turn = MAIN_TURN.has(name)
  if (!known.sessionId) return { sessionId, transcriptPath: transcriptPath ?? null }
  if (known.sessionId !== sessionId) return turn ? { sessionId, transcriptPath: transcriptPath ?? null } : null
  if (!transcriptPath || transcriptPath === known.transcriptPath) return null
  return !known.transcriptPath || turn ? { sessionId, transcriptPath } : null
}
