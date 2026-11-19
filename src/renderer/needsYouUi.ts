import { create } from 'zustand'
import type { NeedsYouBridge, WaitSince } from '../shared/needsYouBridge'
import type { Commands } from './menus'
import { needsYouQueue, nextInQueue } from './needsYou'

declare global {
  interface Window {
    patchbayNeedsYou: NeedsYouBridge
  }
}

/** The jump and peek's calls to main. Looked up on use, so this module can be loaded where there's no window. */
export const needsYouBridge = (): NeedsYouBridge => window.patchbayNeedsYou

/** Where a peek card shows: at the canvas's corner after a jump, or beside the sidebar row it was opened from. */
export type PeekPlace = { from: 'jump' } | { from: 'sidebar'; x: number; y: number }

interface NeedsYouUi {
  peek: ({ id: string } & PeekPlace) | null
  /** A short note, such as "Nothing needs you", until it fades. */
  notice: string | null
  /** The last one jumped to, so the next press goes on from it. */
  last: string | null
  /** Unread agents follow those at Need attention. */
  includeUnread: boolean
}

const KEY = 'patchbay.needsYou'
const NOTICE_MS = 2500

function loadIncludeUnread(): boolean {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')?.includeUnread !== false
  } catch {
    return true
  }
}

export const useNeedsYouUi = create<NeedsYouUi>(() => ({ peek: null, notice: null, last: null, includeUnread: typeof localStorage === 'undefined' ? true : loadIncludeUnread() }))

export function setIncludeUnread(includeUnread: boolean): void {
  useNeedsYouUi.setState({ includeUnread })
  try {
    localStorage.setItem(KEY, JSON.stringify({ includeUnread }))
  } catch {
    // Not kept, but still on for now.
  }
}

export function openPeek(id: string, place: PeekPlace): void {
  useNeedsYouUi.setState({ peek: { id, ...place } })
}

export function closePeek(): void {
  useNeedsYouUi.setState({ peek: null })
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined
function notify(notice: string): void {
  clearTimeout(noticeTimer)
  useNeedsYouUi.setState({ notice })
  noticeTimer = setTimeout(() => useNeedsYouUi.setState({ notice: null }), NOTICE_MS)
}

/**
 * "Next needing you": goes to the agent that has waited longest, or the one after the last gone to, switching project
 * as needed, and opens its peek. Says so when there's nobody.
 */
export async function jumpToNext(c: Commands): Promise<void> {
  let waits: Record<string, WaitSince> = {}
  try {
    waits = await needsYouBridge().waits()
  } catch {
    // Without times the order falls back to the canvas's own.
  }
  // Loaded on use: the store reaches for the window's bridge, and the action list that calls this is loaded in tests.
  const { useStore } = await import('./store')
  const { doc, statuses, attention } = useStore.getState()
  if (!doc) return
  const { last, includeUnread } = useNeedsYouUi.getState()
  const { useAgentStops } = await import('./agentStops')
  const next = nextInQueue(needsYouQueue(doc, statuses, attention, waits, includeUnread, useAgentStops.getState().stops), last)
  if (!next) {
    useNeedsYouUi.setState({ peek: null })
    return notify(includeUnread ? 'Nothing needs you' : 'Nothing needs you. Unread sessions are left out')
  }
  useNeedsYouUi.setState({ last: next.id, notice: null, peek: { id: next.id, from: 'jump' } })
  c.revealNode(next.id)
}
