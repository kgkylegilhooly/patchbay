import { readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { nextStatus } from '../../core/status/machine'
import type { AgentStatus } from '../../shared/model'
import { sessionFromHook, type KnownSession } from './sessionFromHook'

/**
 * While the app is closed, resources/hook.cjs appends each event it can't deliver to a journal, one per node. On
 * reconnect those events tell what really happened, so a node can go straight to its true status. A session with
 * an empty journal has told us nothing, and stays `unknown`.
 */
export interface MissedHook {
  hook_event_name?: unknown
  notification_type?: unknown
  reason?: unknown
  source?: unknown
  session_id?: unknown
  transcript_path?: unknown
  /** When hook.cjs wrote it down. Older journals don't say. */
  at?: unknown
}

export interface MissedSummary {
  status: AgentStatus
  turns: number
  sessionId?: string
  transcriptPath?: string
  /** Only set when the events say. */
  hasConversation?: boolean
  promptSubmitted: boolean
  /** The StopFailure that left it `unknown`, if that's how the events end: why it stopped, such as a usage limit. */
  stopFailure?: MissedHook & Record<string, unknown>
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Pure. Every event sets the status outright or leaves it alone, so starting from `unknown` can't invent one. `known` is
 * the session the window has on record: with its SessionStart lost, the other events can still say (sessionFromHook.ts).
 */
export function foldMissedHooks(events: MissedHook[], known?: KnownSession): MissedSummary {
  const summary: MissedSummary = { status: 'unknown', turns: 0, promptSubmitted: false }
  /** When the session on record was set: a different session written down before that is an older one, not a newer. */
  let sessionAt = 0
  for (const event of events) {
    const name = text(event.hook_event_name)
    if (!name) continue
    const before = summary.status
    summary.status = nextStatus(before, { type: 'hook', name, notificationType: text(event.notification_type), reason: text(event.reason) })
    if (summary.status === 'idle' && before !== 'idle') summary.turns++
    if (name === 'StopFailure' && summary.status === 'unknown') summary.stopFailure = event as MissedHook & Record<string, unknown>
    else if (summary.status !== 'unknown') delete summary.stopFailure
    if (name === 'UserPromptSubmit') {
      summary.promptSubmitted = true
      summary.hasConversation = true
    }
    if (name === 'SessionStart') {
      const source = text(event.source)
      if (source === 'clear') summary.hasConversation = false
      if (source === 'resume') summary.hasConversation = true
      const sessionId = text(event.session_id)
      if (sessionId) {
        summary.sessionId = sessionId
        summary.transcriptPath = text(event.transcript_path)
        if (typeof event.at === 'number') sessionAt = Math.max(sessionAt, event.at)
      }
    }
    const current: KnownSession = summary.sessionId
      ? { sessionId: summary.sessionId, transcriptPath: summary.transcriptPath ?? null, agent: known?.agent }
      : { sessionId: known?.sessionId ?? null, transcriptPath: known?.transcriptPath ?? null, agent: known?.agent }
    const learned = sessionFromHook(current, event as Record<string, unknown>)
    const older = learned && learned.sessionId !== current.sessionId && typeof event.at === 'number' && event.at < sessionAt
    if (learned && !older) {
      if (learned.sessionId !== current.sessionId && typeof event.at === 'number') sessionAt = Math.max(sessionAt, event.at)
      summary.sessionId = learned.sessionId
      summary.transcriptPath = learned.transcriptPath ?? undefined
    }
  }
  return summary
}

export function missedHooksDir(controlDir: string): string {
  return join(controlDir, 'missed')
}

function parseLines(file: string): MissedHook[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const events: MissedHook[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as MissedHook)
    } catch {
      // A hook killed in the middle of writing leaves a partial line.
    }
  }
  return events
}

/** Reads and clears a node's journal: its rolled-over older part first, then the current one. */
export function takeMissedHooks(dir: string, nodeId: string): MissedHook[] {
  const file = join(dir, `${encodeURIComponent(nodeId)}.jsonl`)
  const older = `${file}.old`
  // Moved aside first, so lines appended while it's read go to a new file, read next time, rather than being deleted.
  const taking = `${file}.taking`
  let current = file
  try {
    renameSync(file, taking)
    current = taking
  } catch {
    // Missing, or held open by a hook writing to it: read where it is, as before.
  }
  const events = [...parseLines(older), ...parseLines(taking), ...(current === file ? parseLines(file) : [])]
  for (const f of [older, taking, ...(current === file ? [file] : [])]) {
    try {
      rmSync(f, { force: true })
    } catch {
      // Still held open by a hook writing to it. It's read again next time.
    }
  }
  return events
}
