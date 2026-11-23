import { commandAllowed } from '../shared/agents'
import { useAgentChoice } from './agentChoice'
import { ClaudeIcon, CodexIcon, Icon, TerminalIcon } from './icons'
import type { Commands } from './menus'
import { keyOf } from './a11y/keyHints'
import { useKeyOverrides } from './a11y/useKeyOverrides'

/**
 * What an empty project shows: the three ways most work starts, as buttons, and where the rest lives. The right-click
 * menu stays the full list; this only makes the first step visible.
 */
export function EmptyCanvas({ commands, onContextMenu }: { commands: Commands; onContextMenu: (e: React.MouseEvent) => void }): React.JSX.Element {
  const agents = useAgentChoice()
  // Claude Code when it's on, otherwise Codex, so the first button always starts an agent that can run.
  const agent = commandAllowed('new-claude', agents) ? 'claude' : commandAllowed('new-codex', agents) ? 'codex' : null
  // The one key that reaches everything, and the one that starts the agent, as bound now.
  const keys = useKeyOverrides()
  const paletteKey = keyOf('open-palette', keys)
  const agentKey = agent ? keyOf(`new-${agent}`, keys) : null
  return (
    // "Right-click anywhere" includes the card itself, so it opens the canvas menu there too.
    <section className="stage-empty" aria-labelledby="stage-empty-title" onContextMenu={onContextMenu}>
      <h2 id="stage-empty-title">Start with an agent or a terminal</h2>
      <div className="stage-empty-actions">
        {agent === 'claude' && (
          <button type="button" className="btn btn-solid" data-empty="new-claude" onClick={() => commands.newClaudeForm()}>
            <ClaudeIcon size={15} />
            New Claude Code
          </button>
        )}
        {agent === 'codex' && (
          <button type="button" className="btn btn-solid" data-empty="new-codex" onClick={() => commands.newCodexForm()}>
            <CodexIcon size={15} />
            New Codex
          </button>
        )}
        <button type="button" className="btn" data-empty="new-terminal" onClick={() => commands.newTerminal()}>
          <TerminalIcon size={15} />
          New terminal
        </button>
        <button type="button" className="btn" data-empty="spawn-team" onClick={() => commands.spawnTeamForm()}>
          <Icon name="team" size={15} />
          New team
        </button>
      </div>
      <p>Or right-click anywhere for notes, browsers, whiteboards and more.</p>
      {(paletteKey || agentKey) && (
        <p className="stage-empty-keys" data-empty="keys">
          {paletteKey && (
            <>
              <kbd>{paletteKey}</kbd> finds any action.
            </>
          )}
          {paletteKey && agentKey && ' '}
          {agentKey && (
            <>
              <kbd>{agentKey}</kbd> starts {agent === 'codex' ? 'Codex' : 'Claude Code'}.
            </>
          )}
        </p>
      )}
    </section>
  )
}
