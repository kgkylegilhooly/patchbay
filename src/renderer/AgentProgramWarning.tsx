import { useEffect, useState } from 'react'
import { bridge } from './bridge'
import { openSettingsAt } from './settingsAsk'

/**
 * In a New Claude Code, New Codex or New team form: says up front when the agent's program can't be found, which on
 * a first install is the likeliest reason it won't start, with Settings one click away. Asked once as the form opens
 * (main looks it up off its thread); says nothing until it knows. With no `agent`, the default agent. See
 * docs/plans/r3-start.md.
 */
export function AgentProgramWarning({ agent }: { agent?: 'claude' | 'codex' }): React.JSX.Element | null {
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void bridge
      .agentProgramProblem(agent)
      .then((p) => live && setProblem(p))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [agent])
  if (!problem) return null
  return (
    <p className="pop-warn" role="status" data-program-missing>
      <span>{problem}</span>
      <button type="button" className="btn btn-sm" onClick={() => openSettingsAt('claude')}>
        Settings
      </button>
    </p>
  )
}
