import type { AgentStop } from '../shared/agentStop'
import type { AgentStatus } from '../shared/model'

/** The status colours the minimap paints with: the same `--led-*` tokens the dots use, so the two never disagree. */
export interface LedTokens {
  working: string
  idle: string
  needs: string
  waiting: string
}

/** What styles.css sets, for where there's no stylesheet to read, as in tests. */
export const LED_FALLBACK: LedTokens = { working: '#ff9f43', idle: '#34c759', needs: '#ff453a', waiting: '#7da7ff' }

/** No status to report: a terminal, a command, or an agent Patchbay can't read yet. */
export const NEUTRAL = '#a3abbd'
const ENDED = '#6d7790'

let cached: LedTokens | null = null

/** Reads the tokens once from the page. */
export function ledTokens(root: Element | null = typeof document === 'undefined' ? null : document.documentElement): LedTokens {
  if (cached) return cached
  if (!root) return LED_FALLBACK
  const style = getComputedStyle(root)
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  cached = {
    working: read('--led-working', LED_FALLBACK.working),
    idle: read('--led-idle', LED_FALLBACK.idle),
    needs: read('--led-needs', LED_FALLBACK.needs),
    waiting: read('--led-waiting', LED_FALLBACK.waiting)
  }
  return cached
}

/**
 * A node's colour on the minimap. An agent stopped on an error keeps the status `unknown`, so its stop decides: one
 * only the person can clear, such as a failed login, is red like needs-you; one that clears by itself, such as a
 * usage limit, is amber.
 */
export function statusMapColor(status: AgentStatus | null | undefined, stop: Pick<AgentStop, 'holds'> | undefined, tokens: LedTokens = LED_FALLBACK): string {
  if (status === 'unknown' && stop) return stop.holds === 'person' ? tokens.needs : tokens.working
  switch (status) {
    case 'working':
      return tokens.working
    case 'idle':
      return tokens.idle
    case 'needs-you':
      return tokens.needs
    case 'queued':
    case 'starting':
      return tokens.waiting
    case 'exited':
      return ENDED
    default:
      return NEUTRAL
  }
}
