import { create } from 'zustand'
import type { Rect } from '../core/canvas/place'
import type { TidyScope } from '../core/canvas/tidy'

/** The tidy preview, while it's open. Kept apart from the canvas store: a preview is never saved or undone. */
export interface TidyPreview {
  projectId: string
  scope: TidyScope
  byStatus: boolean
  /** What was selected when it opened, so the bar can switch between it and the whole project. */
  selection: string[]
  /** The view when it opened. The plan uses it, so panning while looking doesn't change the plan. */
  view: Rect | null
}

export const useTidyUi = create<{ preview: TidyPreview | null }>(() => ({ preview: null }))

/** Remembered for the next tidy, as the person last left it. */
let lastByStatus = false

export function openTidy(p: Omit<TidyPreview, 'byStatus'>): void {
  useTidyUi.setState({ preview: { ...p, byStatus: lastByStatus } })
}

export function changeTidy(patch: Partial<Pick<TidyPreview, 'scope' | 'byStatus'>>): void {
  if (patch.byStatus !== undefined) lastByStatus = patch.byStatus
  useTidyUi.setState((s) => ({ preview: s.preview && { ...s.preview, ...patch } }))
}

export const closeTidy = (): void => useTidyUi.setState({ preview: null })
