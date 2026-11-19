import { create } from 'zustand'
import type { HandoffSource, SourceWindow } from '../core/search/types'
import type { SearchBridge } from '../shared/searchBridge'

declare global {
  interface Window {
    patchbaySearch: SearchBridge
  }
}

/** Search's calls to main. Looked up on use, so this module can be loaded where there's no window, as in tests. */
export const searchBridge = (): SearchBridge => window.patchbaySearch

interface SearchUi {
  open: boolean
  /** The conversation a handoff is being prepared from, while its editor is open. */
  handoff: (HandoffSource & { title: string }) | null
}

/** Whether the search drawer and the handoff editor are open. Actions and menus open them from anywhere. */
export const useSearchUi = create<SearchUi>(() => ({ open: false, handoff: null }))

export function toggleSearch(): void {
  useSearchUi.setState((s) => ({ open: !s.open }))
}

export function closeSearch(): void {
  useSearchUi.setState({ open: false })
}

/** Opens the handoff editor on a conversation: "Continue with another agent". */
export function openHandoff(source: HandoffSource, title: string): void {
  useSearchUi.setState({ handoff: { ...source, title } })
}

export function closeHandoff(): void {
  useSearchUi.setState({ handoff: null })
}

/** Ranges as [start, end) cut a snippet into plain and marked parts, in order. */
export function markedParts(text: string, marks: Array<[number, number]>): Array<{ text: string; mark: boolean }> {
  const parts: Array<{ text: string; mark: boolean }> = []
  let at = 0
  for (const [start, end] of marks) {
    if (start < at || end > text.length || end <= start) continue
    if (start > at) parts.push({ text: text.slice(at, start), mark: false })
    parts.push({ text: text.slice(start, end), mark: true })
    at = end
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false })
  return parts
}

export type DateRange = 'any' | 'day' | 'week' | 'month'
const DAY = 24 * 3600_000
export const RANGES: Array<{ id: DateRange; label: string }> = [
  { id: 'any', label: 'Any time' },
  { id: 'day', label: 'Past day' },
  { id: 'week', label: 'Past week' },
  { id: 'month', label: 'Past 30 days' }
]

/** The earliest time a date filter lets through, or none. */
export function rangeStart(range: DateRange, now: number): number | undefined {
  return range === 'day' ? now - DAY : range === 'week' ? now - 7 * DAY : range === 'month' ? now - 30 * DAY : undefined
}

/** How many messages either side of the match the viewer shows first. */
const SPAN = 15
/** How many messages each Earlier or Later page shows. Each page replaces the last, so the view stays small. */
const PAGE = 40

/** The first page of a result: the message that matched, with some either side. */
export function matchPage(entry: number): { from: number; count: number } {
  return { from: Math.max(0, entry - SPAN), count: 2 * SPAN + 1 }
}

/** The page before or after one, which every message can be reached through. */
export function turnPage(w: Pick<SourceWindow, 'start' | 'entries' | 'total'>, way: 'earlier' | 'later'): { from: number; count: number } | null {
  if (way === 'earlier') return w.start > 0 ? { from: Math.max(0, w.start - PAGE), count: Math.min(PAGE, w.start) } : null
  const end = w.start + w.entries.length
  return end < w.total ? { from: end, count: PAGE } : null
}
