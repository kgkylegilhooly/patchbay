import { useState } from 'react'
import { create } from 'zustand'
import { awaySummary, type AwayBridge, type AwayByNode } from '../../shared/away'
import type { AwayChanges } from '../../shared/filesTouched'
import './awayStrip.css'

declare global {
  interface Window {
    patchbayAway?: AwayBridge
  }
}

/** What changed while each resumed agent was away, from src/main/files/away.ts. Connected on first use. */
export const useAway = create<{ byNode: AwayByNode }>(() => ({ byNode: {} }))
let connected = false
function connect(): void {
  const bridge = typeof window === 'undefined' ? undefined : window.patchbayAway
  if (connected || !bridge) return
  connected = true
  bridge.onChange((byNode) => useAway.setState({ byNode }))
  void bridge.get().then((byNode) => useAway.setState({ byNode }))
}

/**
 * On a resumed agent's window: what changed in its checkout since its last turn ended, as when other agents or the
 * person worked there while it was closed. Tell it sends the agent a short list; nothing is sent without that press.
 */
export function AwayStrip({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  connect()
  const away = useAway((s) => s.byNode[nodeId])
  return away ? <AwayStripView nodeId={nodeId} away={away} /> : null
}

/** The strip itself, for changes already found. */
export function AwayStripView({ nodeId, away }: { nodeId: string; away: AwayChanges }): React.JSX.Element {
  const [problem, setProblem] = useState<string | null>(null)
  const names = [...away.commits, ...away.files].slice(0, 6).join('\n')
  const tell = async (): Promise<void> => {
    const r = await window.patchbayAway?.tell(nodeId)
    setProblem(r && !r.ok ? r.reason : null)
  }
  return (
    <div className="strip strip-away" data-away={nodeId}>
      <div className="strip-text" title={names}>
        <strong>{awaySummary(away)}</strong>
        {problem && <span className="strip-away-problem">{problem}</span>}
      </div>
      <div className="strip-actions">
        <button type="button" className="btn nodrag" data-cmd="away-tell" title="Sends it the list of commits and files that changed, so it checks them before relying on what it knew" onClick={() => void tell()}>
          Tell it
        </button>
        <button type="button" className="btn nodrag" data-cmd="away-dismiss" onClick={() => void window.patchbayAway?.dismiss(nodeId)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
