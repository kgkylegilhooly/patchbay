import type { AgentStatus } from '../../shared/model'
import type { AgentStop } from '../../shared/agentStop'
import type { SetupHold } from '../status/setupStatus'
import { runLook, stopLook } from '../status/status'
import type { RunResult } from '../../shared/contract'

/**
 * What a screen reader hears when a window starts to need the person: a permission asked, a turn waiting on them, a
 * failure, a setup that failed, a usage limit. Only the move into one of these is said, once, in a polite live region;
 * the rest (working, idle) would be noise. Pure, so it's tested without a page. See docs/plans/r3-keyboard.md.
 */

export interface AlertFacts {
  title: string
  status: AgentStatus | null
  /** A permission being asked now. */
  approval?: { requestId: string; tool: string }
  /** Why its turn ended, while the status is still the `unknown` StopFailure left. */
  stop?: AgentStop
  setup?: SetupHold
  /** It couldn't start or resume. */
  error?: string
  run?: RunResult
}

export interface Alert {
  /** Changes whenever it's a new thing to say, so the same state isn't said twice. */
  key: string
  text: string
}

/** The one thing worth saying about a window now, most pressing first, or null when there's nothing. */
export function alertOf(f: AlertFacts, now: number): Alert | null {
  const title = f.title.trim() || 'A window'
  if (f.approval) return { key: `ask:${f.approval.requestId}`, text: `${title} needs you: ${f.approval.tool} permission` }
  if (f.status === 'needs-you') return { key: 'needs', text: `${title} needs you` }
  if (f.setup === 'failed') return { key: 'setup-failed', text: `${title}: setup failed` }
  if (f.status === 'unknown' && f.stop) {
    const look = stopLook(f.stop, now)
    return { key: `stop:${f.stop.kind}:${f.stop.at}`, text: `${title} stopped: ${look.label}` }
  }
  if (f.error) return { key: `error:${f.error}`, text: `${title} failed: ${f.error}` }
  if (f.run && runLook(f.run).tone === 'held') return { key: `run:${f.run.at}`, text: `${title} failed: ${runLook(f.run).label}` }
  return null
}

/** What's new to say: windows whose alert changed to something, in the order given. A window that's gone says nothing. */
export function newAlerts(before: ReadonlyMap<string, Alert>, after: ReadonlyMap<string, Alert>): string[] {
  const out: string[] = []
  for (const [id, alert] of after) if (before.get(id)?.key !== alert.key) out.push(alert.text)
  return out
}

/** How long the same words are kept from being said again, and the least time between two announcements. */
export const REPEAT_MS = 15_000
export const GAP_MS = 1_200
/** More than this at once is said as a count, so a burst of agents doesn't read out for a minute. */
export const MOST_AT_ONCE = 3

/**
 * Throttles and dedupes what's said: words said in the last REPEAT_MS are dropped, and what arrives together, or within
 * GAP_MS of the last announcement, is said as one.
 */
export class AnnounceQueue {
  private pending: string[] = []
  private said = new Map<string, number>()
  private lastAt = -Infinity

  push(texts: readonly string[], now: number): void {
    for (const t of texts) {
      const at = this.said.get(t)
      if (at !== undefined && now - at < REPEAT_MS) continue
      if (!this.pending.includes(t)) this.pending.push(t)
    }
  }

  /** When the next announcement may go out, or null when nothing waits. */
  dueAt(): number | null {
    return this.pending.length ? this.lastAt + GAP_MS : null
  }

  /** The words to say now, or null when nothing waits or it's too soon after the last. */
  take(now: number): string | null {
    if (!this.pending.length || now < this.lastAt + GAP_MS) return null
    const texts = this.pending
    this.pending = []
    this.lastAt = now
    for (const t of texts) this.said.set(t, now)
    for (const [t, at] of this.said) if (now - at >= REPEAT_MS) this.said.delete(t)
    return joinAlerts(texts)
  }
}

export function joinAlerts(texts: readonly string[]): string {
  const shown = texts.slice(0, MOST_AT_ONCE).map((t) => (/[.!?]$/.test(t) ? t : `${t}.`))
  const more = texts.length - shown.length
  return more > 0 ? `${shown.join(' ')} And ${more} more.` : shown.join(' ')
}
