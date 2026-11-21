import { useEffect, useState } from 'react'
import type { ResourceWarning } from '../../shared/resources'
import { Icon } from '../icons'
import type { Commands } from '../menus'
import { idleText, resourcesBridge, sizeText } from './resourcesUi'
import './resources.css'

/**
 * The PC is short of memory, or more agents run than your limit: said once, beside the canvas, with the idle agents
 * worth closing. It blocks nothing and closes nothing; main decides when it's worth saying again. See core/resources.
 */
export function ResourceNotice({ commands }: { commands: Pick<Commands, 'revealNode'> }): React.JSX.Element | null {
  const [warning, setWarning] = useState<ResourceWarning | null>(null)
  useEffect(() => resourcesBridge()?.onWarning(setWarning), [])
  if (!warning) return null
  const now = Date.now()
  return (
    <div
      className="res-notice"
      role="status"
      data-resource-warning={warning.kind}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        setWarning(null)
      }}
    >
      <div className="res-notice-text">
        <p className="res-notice-head">{warning.kind === 'agents' ? 'More agents than your limit' : 'Memory is running low'}</p>
        <p>{warning.text}</p>
        {warning.suggestions.length > 0 && (
          <>
            <p>Idle agents you could close:</p>
            <ul className="res-notice-list">
              {warning.suggestions.map((s) => (
                <li key={s.id}>
                  <button type="button" className="res-notice-show" title="Show it on the canvas" onClick={() => commands.revealNode(s.id)}>
                    {s.title || 'Untitled'}
                  </button>
                  <span className="res-notice-meta">
                    {[idleText(s.idleSince, now), s.memory !== null ? sizeText(s.memory) : ''].filter(Boolean).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="res-notice-foot">Settings &gt; Background sessions shows what each session uses.</p>
      </div>
      <button type="button" className="icon-btn res-notice-close" aria-label="Close memory note" title="Close (Esc)" onClick={() => setWarning(null)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}
