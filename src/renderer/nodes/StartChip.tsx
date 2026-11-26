import type { ClaudeNode } from '../../shared/model'
import { startChipText } from '../../shared/startMode'

/** F61: how this Claude was started, when it isn't as in Settings. See shared/startMode.ts. */
export function StartChip({ node }: { node: ClaudeNode }): React.JSX.Element | null {
  const text = startChipText(node)
  if (!text) return null
  return (
    <span className="run-launch" data-start-chip title="How this agent was started, over Settings. Applies again on Restart.">
      {text}
    </span>
  )
}
