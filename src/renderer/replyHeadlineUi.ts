import { create } from 'zustand'
import type {} from './lastReplyUi'

/**
 * F57: an agent's last reply, first line, for the sidebar's tooltip. Read when a row is hovered or focused, and kept
 * until the agent next does something (its status or last activity changes), so hovering again costs nothing.
 */

type Entry = { key: string; text: string | null }

export const useReplyHeadlines = create<Record<string, Entry>>(() => ({}))

/** What a cached headline was read against. A new turn changes the activity time, even back at the same status. */
export const headlineKey = (status: string | null | undefined, activityAt: number | undefined): string => `${status ?? ''}|${activityAt ?? 0}`

const asking = new Set<string>()

/** Reads the headline unless the cached one still fits. */
export async function loadReplyHeadline(id: string, key: string, read = (nodeId: string) => window.patchbayReply?.headline(nodeId)): Promise<void> {
  if (useReplyHeadlines.getState()[id]?.key === key || asking.has(id)) return
  asking.add(id)
  try {
    const text = (await Promise.resolve(read(id)).catch(() => null)) ?? null
    useReplyHeadlines.setState({ [id]: { key, text } })
  } finally {
    asking.delete(id)
  }
}

/** The row's tooltip: where it runs, then what it last said. */
export function rowTitle(where: string, reply: string | null | undefined): string {
  const place = where || 'Home folder'
  return reply ? `${place}\nLast reply: ${reply}` : place
}
