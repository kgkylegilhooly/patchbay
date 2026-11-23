import { create } from 'zustand'
import type { AgentStatus } from '../../shared/model'
import { useStore } from '../store'
import { isReconnecting, SETTLE_MS } from './launchSettle'

/** The agents in the first canvas loaded, and whether it's still the moment after launch. See launchSettle.ts. */
export const useLaunchSettle = create<{ settling: boolean; atLaunch: ReadonlySet<string> }>(() => ({ settling: true, atLaunch: new Set() }))

let watching = false

/** Notes the agents in the first canvas loaded and starts the clock, from when the window first has it. Once. */
export function watchLaunch(): void {
  if (watching) return
  watching = true
  const take = (doc: ReturnType<typeof useStore.getState>['doc']): boolean => {
    if (!doc) return false
    useLaunchSettle.setState({ atLaunch: new Set(doc.nodes.filter((n) => n.kind === 'claude').map((n) => n.id)) })
    setTimeout(() => useLaunchSettle.setState({ settling: false }), SETTLE_MS)
    return true
  }
  if (take(useStore.getState().doc)) return
  const stop = useStore.subscribe((s) => {
    if (take(s.doc)) stop()
  })
}

/** Whether this agent should say Reconnecting now. */
export function useReconnecting(status: AgentStatus | null | undefined, nodeId: string | undefined, stopped: boolean): boolean {
  return useLaunchSettle((s) => !!nodeId && isReconnecting(s.settling, s.atLaunch.has(nodeId), status, stopped))
}
