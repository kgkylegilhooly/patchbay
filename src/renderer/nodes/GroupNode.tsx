import type { NodeProps } from '@xyflow/react'
import { memo, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { GroupNode as GroupModel } from '../../shared/model'
import { bridge } from '../bridge'
import type { FlowNode } from '../flowMapping'
import { closeNodes, patchNode, useStore } from '../store'
import { teamStatus } from '../teamStatus'
import { latestTeamMessage, memberStatuses } from '../teamSelect'
import { StatusMark } from '../status/StatusMarks'
import { EditableTitle, Jacks, Resizer } from './NodeChrome'
import { useHeaderZoom } from '../useHeaderZoom'
import { useAgentStops } from '../agentStops'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import { ContextMenu } from '../Menu'
import { useWorktreeErrors, worktreeMenu } from '../worktreeUi'

export const GROUP_COLORS = ['#49c2c9', '#e2b04a', '#e0689b', '#7fa8ff', '#62dc8a']

function message(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
}

function BindForm({ groupId, onDone }: { groupId: string; onDone: () => void }): React.JSX.Element {
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await bridge.createWorktree(groupId, { repo, branch: branch.trim() })
      onDone()
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  return (
    <form
      className="wt-form nodrag"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <button
        type="button"
        className="btn"
        onClick={() => void bridge.pickFolder().then((folder) => folder && setRepo(folder))}
      >
        {repo ? 'Change repository' : 'Choose repository'}
      </button>
      {repo && (
        <span className="wt-path" title={repo}>
          {repo}
        </span>
      )}
      <input
        aria-label="New branch name"
        placeholder="New branch name"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
      />
      <button className="btn btn-solid" disabled={!repo || !branch.trim() || busy}>
        Create worktree
      </button>
      <button type="button" className="btn" onClick={onDone}>
        Cancel
      </button>
      {error && (
        <span className="wt-error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}

function Bound({ node }: { node: GroupModel }): React.JSX.Element {
  const error = useWorktreeErrors((s) => s[node.id])
  const worktree = node.worktree!
  // Remove worktree… lives in this ⋯ menu (and the right-click menu), not as a red button on every bound header.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  // A press on the button closes an open menu first; the click that follows mustn't open it again.
  const closedAt = useRef(0)

  return (
    <div className="wt-bound nodrag">
      <span className="branch" title={worktree.path}>
        {worktree.branch}
      </span>
      <button className="btn" title="Keeps the folder on disk" onClick={() => void bridge.unbindWorktree(node.id)}>
        Unbind
      </button>
      <button
        type="button"
        className="icon-btn tool-btn wt-more"
        data-wt-more={node.id}
        aria-haspopup="menu"
        aria-expanded={!!menuAt}
        aria-label={`More for worktree ${worktree.branch}`}
        title="More: copy its path, remove it"
        onClick={(e) => {
          if (Date.now() - closedAt.current < 300) return
          const r = e.currentTarget.getBoundingClientRect()
          setMenuAt(menuAt ? null : { x: Math.round(r.right), y: Math.round(r.bottom) + 4 })
        }}
      >
        <Icon name="more" size={15} />
      </button>
      {menuAt && createPortal(<ContextMenu at={menuAt} anchor="end" entries={worktreeMenu(node.id, worktree)} label={`Worktree ${worktree.branch}`} onClose={() => {
            closedAt.current = Date.now()
            setMenuAt(null)
          }} />, document.body)}
      {error && (
        <span className="wt-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

/** A team at a glance: a light per agent, how many are in each state, and the latest thing one of them said. */
function Team({ groupId }: { groupId: string }): React.JSX.Element {
  const nodes = useStore((s) => s.doc?.nodes)
  // Only this team's statuses and latest message, so a change elsewhere on the canvas doesn't render this group.
  const statuses = useStore(useShallow((s) => memberStatuses(s.doc?.nodes, s.statuses, groupId)))
  const lastSaid = useStore((s) => latestTeamMessage(s.doc?.nodes, s.messages, groupId))
  const stops = useAgentStops((s) => s.stops)
  const team = useMemo(() => teamStatus(nodes ?? [], statuses, lastSaid ? [lastSaid] : [], groupId, stops), [nodes, statuses, lastSaid, groupId, stops])
  if (!team.members.length) return <span className="rack-spacer" />
  const titleOf = (id: string): string => nodes?.find((n) => n.id === id)?.title ?? 'a closed node'
  const latest = team.latest
  return (
    <span className="team" role="status" aria-label={`Team: ${team.summary}`}>
      <span className="team-lights" aria-hidden="true">
        {team.members.map((m) => (
          <StatusMark key={m.id} look={m.look} size={8} className="team-light" title={`${m.title}: ${m.look.label}`} />
        ))}
      </span>
      <span className="team-summary">{team.summary}</span>
      {latest && (
        <span className="team-latest" title={`${titleOf(latest.from)} to ${titleOf(latest.to)}: ${latest.text}`}>
          <strong>{titleOf(latest.from)}</strong> to {titleOf(latest.to)}: {latest.text.split('\n')[0]}
        </span>
      )}
    </span>
  )
}

export const GroupNode = memo(function GroupNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as GroupModel
  const headerZoom = useHeaderZoom(node.id)
  const [binding, setBinding] = useState(false)
  const color = node.color ?? GROUP_COLORS[0]

  return (
    <div className={`rack${selected ? ' rack-selected' : ''}`} style={{ '--group': color } as React.CSSProperties}>
      <Resizer node={node} min={{ w: 420, h: 140 }} />
      <Jacks hidden />
      <header className="rack-head" onDoubleClick={headerZoom}>
        <EditableTitle node={node} />
        {selected && (
          <span className="swatches nodrag" role="group" aria-label="Group color">
            {GROUP_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch${c === color ? ' swatch-on' : ''}`}
                style={{ background: c }}
                aria-label={`Use color ${c}`}
                aria-pressed={c === color}
                onClick={() => patchNode(node.id, { color: c })}
              />
            ))}
          </span>
        )}
        {node.worktree ? (
          <Bound node={node} />
        ) : binding ? (
          <BindForm groupId={node.id} onDone={() => setBinding(false)} />
        ) : (
          <button className="btn nodrag" onClick={() => setBinding(true)}>
            Bind worktree
          </button>
        )}
        <Team groupId={node.id} />
        <button
          className="icon-btn nodrag"
          aria-label={`Ungroup ${node.title}`}
          title="Ungroup, keeping the nodes inside"
          onClick={() => closeNodes([node.id])}
        >
          ×
        </button>
      </header>
    </div>
  )
})
