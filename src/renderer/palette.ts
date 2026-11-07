/** Fuzzy search for the command palette. Pure, so the ranking can be tested without a window. */

export interface PaletteItem {
  id: string
  label: string
  /** Searched too, for words the label doesn't use. */
  keywords?: string[]
  /** Shown beside it. Also searched, as with a session's project. */
  detail?: string
}

/**
 * How well the letters of the query appear in order in the text, or null if they don't. Consecutive letters and the
 * starts of words count for more, and an earlier match beats a later one.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let from = 0
  let last = -2
  for (const c of q) {
    if (c === ' ') continue
    const at = t.indexOf(c, from)
    if (at === -1) return null
    if (at === last + 1) score += 8
    if (at === 0 || /[\s\-_/\\.:]/.test(t[at - 1])) score += 10
    score += 1
    score -= Math.min(at - from, 6) * 0.25
    last = at
    from = at + 1
  }
  return score
}

/**
 * Keywords and details can be long, like a folder path, where scattered letters would match almost any query. So
 * they only count when the query appears in them unbroken.
 */
function unbrokenScore(query: string, text: string | undefined, penalty: number): number | null {
  const q = query.replace(/\s+/g, '').toLowerCase()
  if (!text || !q || !text.toLowerCase().includes(q)) return null
  const s = fuzzyScore(q, text)
  return s === null ? null : s - penalty
}

function itemScore(query: string, item: PaletteItem): number | null {
  const scores = [
    fuzzyScore(query, item.label),
    ...(item.keywords ?? []).map((k) => unbrokenScore(query, k, 2)),
    unbrokenScore(query, item.detail, 4)
  ].filter((s): s is number => s !== null)
  return scores.length ? Math.max(...scores) : null
}

/** With no query: recent actions first, then everything in its given order. With one: the best matches first. */
export function rankPalette<T extends PaletteItem>(query: string, items: T[], recent: string[]): T[] {
  const recency = new Map(recent.map((id, i) => [id, recent.length - i]))
  if (!query.trim()) {
    const used = items.filter((i) => recency.has(i.id)).sort((a, b) => recency.get(b.id)! - recency.get(a.id)!)
    return [...used, ...items.filter((i) => !recency.has(i.id))]
  }
  return items
    .map((item, order) => ({ item, order, score: itemScore(query, item) }))
    .filter((r): r is { item: T; order: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || (recency.get(b.item.id) ?? 0) - (recency.get(a.item.id) ?? 0) || a.order - b.order)
    .map((r) => r.item)
}

const RECENT_LIMIT = 8

export function noteRecent(recent: string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_LIMIT)
}
