import { create } from 'zustand'

/** Which comparison sheet is open. Kept apart from the canvas store, so comparisons add no state to it. */
export const useCompareUi = create<{ start: { source?: string; brief?: string; taskId?: string } | null; view: { id: string | null; notice?: string; at: number } | null }>(() => ({ start: null, view: null }))

/** The start dialog. From an agent, its folder is the source and its prompt the brief to begin from. */
export const openTryApproach = (from?: { source?: string; brief?: string; taskId?: string }): void => useCompareUi.setState({ start: from ?? {}, view: null })
/** The comparison view, on one comparison or on the latest. */
export const openComparisons = (id: string | null = null, notice?: string): void => useCompareUi.setState({ start: null, view: { id, notice, at: Date.now() } })
export const closeCompare = (): void => useCompareUi.setState({ start: null, view: null })
