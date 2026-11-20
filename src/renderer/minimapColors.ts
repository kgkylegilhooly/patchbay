import type { AgentStop } from '../shared/agentStop'
import type { AgentStatus } from '../shared/model'
import type { RunResult } from '../shared/contract'
import { agentLook, runLook, TONE_TOKENS, TOKEN_FALLBACK, type Tone } from './status/status'

/** The colour of each status tone, read from the same CSS tokens the marks use, so the minimap never disagrees. */
export type ToneColors = Record<Tone, string>

const toneColors = (read: (token: string) => string): ToneColors =>
  Object.fromEntries((Object.keys(TONE_TOKENS) as Tone[]).map((tone) => [tone, read(TONE_TOKENS[tone])])) as ToneColors

/** What status.css sets, for where there's no stylesheet to read, as in tests. */
export const TONE_FALLBACK: ToneColors = toneColors((token) => TOKEN_FALLBACK[token])

let cached: ToneColors | null = null

/** Reads the tokens once from the page. */
export function ledTokens(root: Element | null = typeof document === 'undefined' ? null : document.documentElement): ToneColors {
  if (cached) return cached
  if (!root) return TONE_FALLBACK
  const style = getComputedStyle(root)
  cached = toneColors((token) => style.getPropertyValue(token).trim() || TOKEN_FALLBACK[token])
  return cached
}

/**
 * A node's colour on the minimap: its tone's colour. An agent stopped on an error keeps the status `unknown`, so its
 * stop decides: one the person has to clear, such as a failed login, is red; one that clears by itself, such as a
 * usage limit, is amber.
 */
export function statusMapColor(status: AgentStatus | null | undefined, stop: AgentStop | undefined, colors: ToneColors = TONE_FALLBACK, now = Date.now()): string {
  return colors[agentLook(status, stop, now).tone]
}

/** A run command's colour on the minimap: amber while it runs, red when it failed, as its mark. */
export function runMapColor(run: RunResult | undefined, colors: ToneColors = TONE_FALLBACK): string {
  return colors[runLook(run).tone]
}
