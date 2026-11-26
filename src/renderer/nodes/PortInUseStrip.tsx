import { holderOf, portStripText } from '../../shared/portInUse'
import { bridge } from '../bridge'
import { confirmThen } from '../shell/confirmStore'
import { useStore } from '../store'

/**
 * F68: a run or terminal that failed because its port is taken. The strip names the window `ports` says serves it, with
 * Go to it, and Stop it… for a run (asking first). With no window holding it, it says another program does.
 */

let goTo: ((id: string) => void) | null = null

/** The app's own "go to this window" (commands.revealNode), registered by App. */
export function setPortGoTo(fn: ((id: string) => void) | null): void {
  goTo = fn
}

export function PortInUseStrip({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const state = useStore((s) => s.portInUse[nodeId])
  const holderId = useStore((s) => holderOf(s.ports, s.portInUse[nodeId]?.port ?? null, nodeId))
  const holder = useStore((s) => (holderId ? s.doc?.nodes.find((n) => n.id === holderId) : undefined))
  if (!state) return null
  const stop = (): void => {
    if (!holder) return
    void confirmThen(
      { title: `Stop ${holder.title}?`, message: `It serves port ${state.port}. Stopping it frees the port, so this can run.`, verb: 'Stop it', cancelLabel: 'Keep it', icon: 'stop', attrs: { 'data-confirm': 'port-stop' } },
      () => void bridge.stopRun(holder.id)
    )
  }
  return (
    <div className="strip strip-error" role="status" data-port-in-use={state.port ?? ''}>
      <div className="strip-text">
        <span>{portStripText(state.port, holder?.title ?? null)}</span>
      </div>
      <div className="strip-actions">
        {holder && (
          <button type="button" className="btn nodrag" data-cmd="port-go-to" onClick={() => goTo?.(holder.id)}>
            Go to it
          </button>
        )}
        {holder?.kind === 'run' && (
          <button type="button" className="btn nodrag" data-cmd="port-stop" onClick={stop}>
            Stop it…
          </button>
        )}
        <button type="button" className="btn nodrag" onClick={() => void bridge.dismissPortInUse(nodeId)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
