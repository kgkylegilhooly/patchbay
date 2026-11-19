import { toggleSubagentCards, useSubagentUi } from './subagentUi'

/**
 * The Eye button in a Claude window's header: how many subagents ran this turn, and whether their cards show. Only
 * there once the window has started one.
 */
export function SubagentEye({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const ran = useSubagentUi((s) => s.groups[nodeId]?.ran ?? 0)
  const running = useSubagentUi((s) => s.groups[nodeId]?.cards.filter((c) => c.status === 'running').length ?? 0)
  const hidden = useSubagentUi((s) => !!s.hidden[nodeId])
  if (ran === 0) return null
  const what = `${ran} ${ran === 1 ? 'subagent' : 'subagents'} this turn${running ? `, ${running} running` : ''}`
  return (
    <button
      type="button"
      className={`sa-eye nodrag${hidden ? ' sa-eye-off' : ''}${running ? ' sa-eye-busy' : ''}`}
      aria-pressed={!hidden}
      aria-label={`${hidden ? 'Show' : 'Hide'} subagent cards. ${what}.`}
      title={`${what}. Click to ${hidden ? 'show' : 'hide'} their cards.`}
      data-subagent-eye={nodeId}
      onClick={() => toggleSubagentCards(nodeId)}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
        {hidden && <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
      </svg>
      <span className="sa-count">{ran}</span>
    </button>
  )
}
