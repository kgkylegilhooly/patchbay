import { runInNewContext } from 'node:vm'
import { toAmount, type ReadResult } from './usageSource'

const MAX_TEXT_CHARS = 200 * 1024
/** A badly written pattern can run for hours, and this runs in the process holding every session. */
const PATTERN_LIMIT_MS = 500

type Found = { value: string } | { problem: string }

function find(text: string, pattern: string, name: string): Found {
  let groups: string[] | null
  try {
    groups = runInNewContext('{ const m = new RegExp(pattern).exec(text); m && Array.from(m) }', { pattern, text }, { timeout: PATTERN_LIMIT_MS })
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { problem: `The ${name} pattern took too long to run.` }
    return { problem: `The ${name} pattern isn't valid.` }
  }
  if (!groups) return { problem: `The ${name} pattern wasn't found on the page.` }
  if (groups.length < 2) return { problem: `The ${name} pattern needs round brackets around the amount.` }
  return { value: groups[1] ?? '' }
}

/** Finds the amounts in a page's text. No page text goes into a problem. */
export function readFromText(page: string, usedPattern: string, limit: { fixed?: number; pattern?: string }): ReadResult {
  if (!usedPattern) return { ok: false, problem: 'Set a pattern for the amount used.' }
  if (limit.fixed === undefined && !limit.pattern) return { ok: false, problem: 'Set a limit, or a pattern to find it.' }
  const text = page.slice(0, MAX_TEXT_CHARS)

  const usedText = find(text, usedPattern, 'amount')
  if ('problem' in usedText) return { ok: false, problem: usedText.problem }
  const used = toAmount(usedText.value)
  if (used === null) return { ok: false, problem: "What the amount pattern found isn't an amount." }
  if (limit.fixed !== undefined) return { ok: true, used, limit: limit.fixed }

  const limitText = find(text, limit.pattern ?? '', 'limit')
  if ('problem' in limitText) return { ok: false, problem: limitText.problem }
  const parsed = toAmount(limitText.value)
  if (parsed === null) return { ok: false, problem: "What the limit pattern found isn't an amount." }
  return { ok: true, used, limit: parsed }
}
