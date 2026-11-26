import { create } from 'zustand'
import type { TriggerNode } from '../shared/model'

/**
 * F46: Send later. "Check the deploy at 9" meant the trigger form and an arming review for one message. An agent's menu
 * opens a box for the message and a time, and that makes an ordinary trigger beside the agent, for once at that time,
 * armed with exactly what was written: the box is the review, as the form's review is. It stays on the canvas, where
 * disarming or deleting it cancels it, and it never starts a session (a stopped agent is a missed run).
 */

/** "HH:MM" as the next time it comes: today, or tomorrow once it has passed. Null for a time that isn't one. */
export function nextAtFor(hhmm: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const [h, min] = [Number(m[1]), Number(m[2])]
  if (h > 23 || min > 59) return null
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  // Within a minute of now still means today: "in a moment", not tomorrow.
  if (d.getTime() < now - 60_000) d.setDate(d.getDate() + 1)
  return d.getTime()
}

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** The trigger that sends `text` to the agent once, at `at`. `base` is a new trigger placed beside it. */
export function laterTrigger(base: TriggerNode, agentId: string, text: string, at: number): TriggerNode {
  return { ...base, title: `Send at ${clock(at)}`, schedule: { type: 'once', at }, prompt: text.trim(), targetId: agentId }
}

/** The agent whose box is open, and what makes and arms its trigger (useCommands' scheduleSend). */
export const useSendLater = create<{ nodeId: string | null; schedule: ((text: string, at: number) => Promise<{ ok: true } | { ok: false; reason: string }>) | null }>(() => ({
  nodeId: null,
  schedule: null
}))
export const closeSendLater = (): void => useSendLater.setState({ nodeId: null, schedule: null })
