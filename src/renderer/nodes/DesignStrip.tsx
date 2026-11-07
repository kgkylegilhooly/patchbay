import { useMemo, useState } from 'react'
import { designMessage, type DesignPick } from '../../shared/design'
import { agentOf, AGENT_NAMES } from '../../shared/model'
import { designTargets } from '../agentTargets'
import { bridge } from '../bridge'
import { useStore } from '../store'

export type DesignState = { kind: 'off' } | { kind: 'picking' } | { kind: 'picked'; pick: DesignPick } | { kind: 'failed'; reason: string }

export function startPicking(nodeId: string, set: (s: DesignState) => void): void {
  set({ kind: 'picking' })
  void bridge.browserPick(nodeId).then((r) => {
    if (!r.ok) set({ kind: 'failed', reason: r.reason })
    else set(r.pick ? { kind: 'picked', pick: r.pick } : { kind: 'off' })
  })
}

export function DesignStrip({ nodeId, state, set }: { nodeId: string; state: DesignState; set: (s: DesignState) => void }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const targets = useMemo(() => designTargets(doc, nodeId), [doc, nodeId])
  const [note, setNote] = useState('')
  const [to, setTo] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  if (state.kind === 'off') return null
  if (state.kind === 'picking') {
    return (
      <div className="strip strip-design nodrag" data-design="picking">
        <div className="strip-text">
          <strong>Design mode</strong>
          <span>Point at an element in the page and click it. Esc stops.</span>
        </div>
        <div className="strip-actions">
          <button type="button" className="btn" onClick={() => void bridge.browserCancelPick(nodeId)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <div className="strip strip-design nodrag" role="status">
        <div className="strip-text">
          <span>Design mode couldn't start: {state.reason}</span>
        </div>
        <div className="strip-actions">
          <button type="button" className="btn" onClick={() => set({ kind: 'off' })}>
            Close
          </button>
        </div>
      </div>
    )
  }
  const { pick } = state
  const chosen = targets.find((t) => t.id === to) ?? targets[0]
  const message = designMessage(pick, note)
  const send = async (): Promise<void> => {
    if (!chosen) return
    const r = await bridge.sendToAgent(chosen.id, message)
    setResult(r.ok ? { ok: true, text: r.queued ? `Queued for ${chosen.title}.` : `Sent to ${chosen.title}.` } : { ok: false, text: r.reason })
    if (r.ok) setNote('')
  }
  return (
    <div className="strip strip-design design-picked nodrag nowheel" data-design="picked">
      <div className="design-head">
        <code className="design-selector" title={pick.selector}>
          {pick.selector}
        </code>
        <span className="design-size">
          {Math.round(pick.width)}×{Math.round(pick.height)}
        </span>
      </div>
      <textarea className="design-note" aria-label="What should change" placeholder="What should change? For example: make this button larger and blue" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="design-actions">
        {targets.length > 0 ? (
          <select aria-label="Send to" value={chosen?.id ?? ''} onChange={(e) => setTo(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} ({AGENT_NAMES[agentOf(t)]})
              </option>
            ))}
          </select>
        ) : (
          <span className="design-none">Open an agent to send this to.</span>
        )}
        <button type="button" className="btn btn-solid" data-design="send" disabled={!chosen} onClick={() => void send()}>
          Send to agent
        </button>
        <button type="button" className="btn" data-design="copy" onClick={() => void navigator.clipboard.writeText(message).then(() => setResult({ ok: true, text: 'Copied.' }))}>
          Copy
        </button>
        <button type="button" className="btn" data-design="again" onClick={() => startPicking(nodeId, set)}>
          Pick another
        </button>
        <button type="button" className="icon-btn" aria-label="Close design mode" onClick={() => set({ kind: 'off' })}>
          ×
        </button>
      </div>
      {result && (
        <div className={result.ok ? 'design-result' : 'design-result design-result-bad'} role="status">
          {result.text}
        </div>
      )}
    </div>
  )
}
