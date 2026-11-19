import { create } from 'zustand'
import type { HandoffSource } from '../core/search/types'
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
