import { useState } from 'react'
import { canContinue, type AgentStop } from '../../shared/agentStop'
import { say } from '../reader/readerUi'

/**
 * Beside an agent stopped on a server or unknown error: sends "continue", as the person would type, through the usual
 * queue. Once per stop, so a second press can't send it twice before the agent moves.
 */
export function ContinueButton({ nodeId, stop }: { nodeId: string; stop: AgentStop | undefined }): React.JSX.Element | null {
  const [sentFor, setSentFor] = useState<number | null>(null)
  if (!stop || !canContinue(stop)) return null
  const sent = sentFor === stop.at
  return (
    <button
      type="button"
      className="btn nodrag"
      data-cmd="continue-after-stop"
      disabled={sent}
      title="Sends “continue”, so it tries again from where it stopped"
      onClick={() => {
        setSentFor(stop.at)
        void window.patchbay.sendToAgent(nodeId, 'continue').then((r) => {
          if (!r.ok) {
            setSentFor(null)
            say(r.reason)
          }
        })
      }}
    >
      {sent ? 'Sent' : 'Continue'}
    </button>
  )
}
