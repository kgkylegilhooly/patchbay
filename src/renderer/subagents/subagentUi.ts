import { create } from 'zustand'
import type { SubagentBridge, SubagentSnapshot } from '../../shared/subagents'

declare global {
  interface Window {
    patchbaySubagents?: SubagentBridge
  }
}

/**
 * Subagent cards on screen: what main last reported, which windows have theirs hidden, and the transcript open.
 * Kept apart from the canvas store, so nothing here is saved with the canvas or can be undone.
 */
export interface SubagentUi {
  groups: SubagentSnapshot
  /** Windows whose cards the Eye button has hidden. Remembered on this computer. */
  hidden: Record<string, true>
  viewing: { nodeId: string; agentId: string; title: string } | null
}

const HIDDEN_KEY = 'patchbay.subagentCardsHidden'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function loadHidden(from: Storage | null = storage()): Record<string, true> {
  try {
    const ids = JSON.parse(from?.getItem(HIDDEN_KEY) ?? '[]')
    return Array.isArray(ids) ? Object.fromEntries(ids.filter((id): id is string => typeof id === 'string').map((id) => [id, true as const])) : {}
  } catch {
    return {}
  }
}

/** Hides a window's cards, or shows them again. */
export function toggleHidden(hidden: Record<string, true>, nodeId: string): Record<string, true> {
  const next = { ...hidden }
  if (next[nodeId]) delete next[nodeId]
  else next[nodeId] = true
  return next
}

/** Only the windows still on the canvas. */
export function pruneHidden(hidden: Record<string, true>, liveIds: string[]): Record<string, true> {
  const live = new Set(liveIds)
  return Object.fromEntries(Object.keys(hidden).filter((id) => live.has(id)).map((id) => [id, true as const]))
}

export function saveHidden(hidden: Record<string, true>, to: Storage | null = storage()): void {
  try {
    to?.setItem(HIDDEN_KEY, JSON.stringify(Object.keys(hidden)))
  } catch {
    // Full or blocked storage: the choice lasts until the app closes.
  }
}

export const useSubagentUi = create<SubagentUi>(() => ({ groups: {}, hidden: loadHidden(), viewing: null }))

/** `liveIds`, the windows on the canvas, drops closed ones from the list as it's saved. */
export const toggleSubagentCards = (nodeId: string, liveIds?: string[]): void => {
  let hidden = toggleHidden(useSubagentUi.getState().hidden, nodeId)
  if (liveIds) hidden = pruneHidden(hidden, liveIds)
  saveHidden(hidden)
  useSubagentUi.setState({ hidden })
}

export const viewSubagent = (nodeId: string, agentId: string, title: string): void => useSubagentUi.setState({ viewing: { nodeId, agentId, title } })
export const closeSubagentView = (): void => useSubagentUi.setState({ viewing: null })

/** Follows main's reports. Returns the way to stop. */
export function followSubagents(bridge: SubagentBridge | undefined = window.patchbaySubagents): () => void {
  if (!bridge) return () => {}
  let live = true
  const stop = bridge.onCards((groups) => useSubagentUi.setState({ groups }))
  void bridge.get().then((groups) => {
    if (live) useSubagentUi.setState((s) => (Object.keys(s.groups).length ? s : { groups }))
  })
  return () => {
    live = false
    stop()
  }
}

const AGENT_TYPE_NAMES: Record<string, string> = { 'general-purpose': 'General' }

/** A subagent's type as people read it: "general-purpose" is General, and the rest start with a capital. */
export function agentTypeLabel(agentType: string): string {
  const named = AGENT_TYPE_NAMES[agentType]
  if (named) return named
  return agentType ? agentType[0].toUpperCase() + agentType.slice(1) : 'Subagent'
}
