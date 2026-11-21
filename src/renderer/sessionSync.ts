import { create } from 'zustand'
import type { JoinedRefusal, SessionSyncBridge } from '../shared/sessionSync'

declare global {
  interface Window {
    patchbaySync?: SessionSyncBridge
  }
}

/** Which nodes show the notice that Restart, a reconnect or a check found their session still running. See sessionSyncUi.tsx. */
export const useJoined = create<{ joined: Record<string, true> }>(() => ({ joined: {} }))
// Main says so when a reconnect or a check shows again a session the canvas had shown as ended.
if (typeof window !== 'undefined') window.patchbaySync?.onJoined((id) => noteJoined(id, { joined: true }))

/** Takes Restart's answer. True when it joined a session still running, whose notice is shown here, not as a problem. */
export function noteJoined(id: string, result: unknown): boolean {
  const joined = !!result && typeof result === 'object' && (result as Partial<JoinedRefusal>).joined === true
  useJoined.setState((s) => {
    if (joined === !!s.joined[id]) return s
    const next = { ...s.joined }
    if (joined) next[id] = true
    else delete next[id]
    return { joined: next }
  })
  return joined
}

