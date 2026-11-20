import type { NodeProps } from '@xyflow/react'
import { memo, useMemo, useState } from 'react'
import type { GroupNode as GroupModel } from '../../shared/model'
import { bridge } from '../bridge'
import type { FlowNode } from '../flowMapping'
import { closeNodes, patchNode, useStore } from '../store'
import { teamStatus } from '../teamStatus'
import { EditableTitle, Jacks, Resizer } from './NodeChrome'
import { useHeaderZoom } from '../useHeaderZoom'
import { useAgentStops } from '../agentStops'

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
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const worktree = node.worktree!

  const remove = async (): Promise<void> => {
    setConfirming(false)
    try {
      const r = await bridge.removeWorktree(node.id)
      setError(r.ok ? null : r.reason)
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <div className="wt-bound nodrag">
      <span className="branch" title={worktree.path}>
        {worktree.branch}
      </span>
      {confirming ? (
        <div className="wt-form wt-confirm" role="alertdialog" aria-label="Remove this worktree?">
          <span>Delete this worktree's folder, including git-ignored files? Sessions in it stop. The branch stays.</span>
          <button className="btn" onClick={() => setConfirming(false)}>
            Keep
          </button>
          <button className="btn btn-danger" onClick={() => void remove()}>
            Remove
          </button>
        </div>
      ) : (
        <>
          <button className="btn" title="Keeps the folder on disk" onClick={() => void bridge.unbindWorktree(node.id)}>
            Unbind
          </button>
          <button className="btn wt-remove" onClick={() => setConfirming(true)}>
            Remove worktree…
          </button>
        </>
      )}
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
  const statuses = useStore((s) => s.statuses)
  const messages = useStore((s) => s.messages)
  const stops = useAgentStops((s) => s.stops)
  const team = useMemo(() => teamStatus(nodes ?? [], statuses, messages, groupId, stops), [nodes, statuses, messages, groupId, stops])
  if (!team.members.length) return <span className="rack-spacer" />
  const titleOf = (id: string): string => nodes?.find((n) => n.id === id)?.title ?? 'a closed node'
  const latest = team.latest
  return (
    <span className="team" role="status" aria-label={`Team: ${team.summary}`}>
      <span className="team-lights" aria-hidden="true">
        {team.members.map((m) => (
          <span key={m.id} className={`team-light team-${m.status}`} title={`${m.title}: ${m.status}`} />
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
