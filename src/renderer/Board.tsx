import { useCallback, useEffect, useRef, useState } from 'react'
import { addColumn, cardsByColumn, columnOf, defaultBoard, issueKey, moveCard, moveColumn, removeColumn, renameColumn, setStartsWork, type Board as BoardModel, type CardFilter } from '../shared/board'
import type { GithubIssue } from '../shared/git'
import { issuePrompt } from '../shared/issuePrompt'
import { isSessionNode, type SessionNode } from '../shared/model'
import { Icon, KindIcon } from './icons'
import type { Commands } from './menus'
import { RunDot, RunLabel, StatusBadge, StatusDot } from './nodes/StatusBadge'
import { dispatch, useStore } from './store'
import { contextLabel } from './usageView'
import { work } from './workBridge'
import { useAgentChoice } from './agentChoice'
import { agentOffReason } from '../shared/agents'
import './work.css'
import { SessionTaskOutcomes, TaskOutcomes } from './tasks/TaskOutcomes'
import { shortPath } from './shortPath'
import { Panel } from './shell/Panel'
import { confirmThen } from './shell/confirmStore'

type Drag = { key: string; x: number; y: number; over: string | null }
type IssueAsk = { issue: GithubIssue; kind: 'close' | 'reopen' | 'comment'; body: string }
type StartAsk = { issue: GithubIssue; column: string; prompt: string; worktree: boolean; branch: string }

const ISSUE_REFRESH_MS = 60_000

function activeBoard(): { projectId: string; board: BoardModel } | null {
  const doc = useStore.getState().doc
  const project = doc?.projects.find((p) => p.id === doc.activeProjectId)
  return project ? { projectId: project.id, board: project.board ?? defaultBoard() } : null
}

/** Saves a change to the board on screen, made against what's saved now rather than what was last drawn. */
function change(edit: (b: BoardModel) => BoardModel): void {
  const now = activeBoard()
  if (!now) return
  const next = edit(now.board)
  if (next !== now.board) dispatch({ op: 'setBoard', projectId: now.projectId, board: next })
}

function SessionCard({ node }: { node: SessionNode }): React.JSX.Element {
  const status = useStore((s) => s.statuses[node.id] ?? (node.kind === 'claude' ? 'unknown' : null))
  const run = useStore((s) => s.runs[node.id])
  const context = contextLabel(useStore((s) => s.usage.nodes[node.id]))
  const root = useStore((s) => s.doc?.projects.find((p) => p.id === node.projectId)?.folder)
  return (
    <>
      <span className="card-top">
        {node.kind === 'run' ? <RunDot run={run} /> : <StatusDot status={status} nodeId={node.id} />}
        <KindIcon kind={node.kind} agent={node.kind === 'claude' ? node.agent : undefined} />
        <span className="card-title">{node.title}</span>
      </span>
      <span className="card-meta">
        {status && <StatusBadge status={status} nodeId={node.id} />}
        {node.kind === 'run' && <RunLabel run={run} />}
        {context && <span className={`session-context usage-${context.level}`}>{context.text}</span>}
      </span>
      <span className="card-where" title={node.cwd || undefined}>{node.cwd ? shortPath(node.cwd, root) : 'Home folder'}</span>
      <SessionTaskOutcomes sessionId={node.id} />
    </>
  )
}

function IssueCard({ issue, open, agent, onAsk }: { issue: GithubIssue; open: boolean; agent: string | null; onAsk: (kind: IssueAsk['kind']) => void }): React.JSX.Element {
  return (
    <>
      <span className="card-top">
        <span className={`issue-state issue-${issue.state.toLowerCase()}`} title={issue.state === 'OPEN' ? 'Open' : 'Closed'} />
        <span className="issue-number">#{issue.number}</span>
        <span className="card-title">{issue.title}</span>
      </span>
      <span className="card-meta">
        {issue.labels.map((l) => (
          <span key={l} className="issue-label">{l}</span>
        ))}
        {issue.author && <span className="card-where">by {issue.author}</span>}
        {agent && <span className="issue-agent" title="A session was started on this issue">Agent: {agent}</span>}
      </span>
      {open && (
        <span className="issue-open" onPointerDown={(e) => e.stopPropagation()}>
          {/* React shows this as text, never as markup: the issue was written by someone else. */}
          <span className="issue-body">{issue.body || 'No description.'}</span>
          <span className="issue-tools">
            <button type="button" className="btn btn-sm btn-quiet" data-issue-tool="open" onClick={() => void work.openGithubPage(issue.url)}>Open on GitHub</button>
            {issue.state === 'OPEN' ? (
              <button type="button" className="btn btn-sm btn-quiet" data-issue-tool="close" onClick={() => onAsk('close')}>Close…</button>
            ) : (
              <button type="button" className="btn btn-sm btn-quiet" data-issue-tool="reopen" onClick={() => onAsk('reopen')}>Reopen…</button>
            )}
            <button type="button" className="btn btn-sm btn-quiet" data-issue-tool="comment" onClick={() => onAsk('comment')}>Comment…</button>
          </span>
        </span>
      )}
    </>
  )
}

export function Board({ commands }: { commands: Commands }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const [filter, setFilter] = useState<CardFilter>('all')
  const [issues, setIssues] = useState<{ repo: string; list: GithubIssue[] } | null>(null)
  const [issueError, setIssueError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [openIssue, setOpenIssue] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [ask, setAsk] = useState<IssueAsk | null>(null)
  const [start, setStart] = useState<StartAsk | null>(null)
  // Settings > Agents: an issue's work starts in Claude Code, so it can't while Claude Code is off.
  const claudeOff = agentOffReason('claude', useAgentChoice())
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [repoDraft, setRepoDraft] = useState<string | null>(null)
  const loadedAt = useRef(0)

  const project = doc?.projects.find((p) => p.id === doc.activeProjectId)
  const board = project?.board ?? defaultBoard()
  const enabled = !!board.issues?.enabled
  const projectId = project?.id

  const loadIssues = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    loadedAt.current = Date.now()
    const r = await work.githubIssues(projectId)
    setLoading(false)
    if (r.ok) {
      setIssues({ repo: r.repo, list: r.issues })
      setIssueError(null)
    } else setIssueError(r.error)
  }, [projectId])

  useEffect(() => {
    setIssues(null)
    setIssueError(null)
    if (enabled) void loadIssues()
  }, [enabled, loadIssues, board.issues?.repo])

  useEffect(() => {
    const onFocus = (): void => {
      if (enabled && Date.now() - loadedAt.current > ISSUE_REFRESH_MS) void loadIssues()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, loadIssues])

  const close = useCallback(() => useStore.setState({ boardOpen: false }), [])
  if (!doc || !project) return null

  const sessions = doc.nodes.filter((n): n is SessionNode => isSessionNode(n) && n.projectId === project.id)
  const shownIssues = enabled && issues ? issues.list : []
  const issueByKey = new Map(shownIssues.map((i) => [issueKey(i.number), i]))
  const nodeById = new Map(sessions.map((n) => [n.id, n]))
  const keys = [...(filter !== 'issues' ? sessions.map((n) => n.id) : []), ...(filter !== 'sessions' ? shownIssues.map((i) => issueKey(i.number)) : [])]
  const byColumn = cardsByColumn(board, keys)
  const allKeys = [...sessions.map((n) => n.id), ...shownIssues.map((i) => issueKey(i.number))]

  const drop = (key: string, columnId: string): void => {
    if (columnOf(board, key) === columnId) return
    const issue = issueByKey.get(key)
    const column = board.columns.find((c) => c.id === columnId)
    if (issue && column?.startsWork && issues && !board.started?.[key]) {
      setStart({ issue, column: columnId, prompt: issuePrompt(issues.repo, issue), worktree: false, branch: `issue-${issue.number}` })
      return
    }
    change((b) => moveCard(b, key, columnId))
  }

  const onCardDown = (e: React.PointerEvent, key: string): void => {
    if (e.button !== 0) return
    const x0 = e.clientX
    const y0 = e.clientY
    let moved = false
    const overAt = (x: number, y: number): string | null => (document.elementFromPoint(x, y)?.closest('[data-column]') as HTMLElement | null)?.dataset.column ?? null
    const move = (m: PointerEvent): void => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return
      moved = true
      setDrag({ key, x: m.clientX, y: m.clientY, over: overAt(m.clientX, m.clientY) })
    }
    const up = (u: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      setDrag(null)
      if (moved) {
        const over = overAt(u.clientX, u.clientY)
        if (over) drop(key, over)
      } else if (nodeById.has(key)) {
        // The real session, on the canvas: the board only steps aside.
        close()
        commands.revealNode(key)
      } else setOpenIssue((o) => (o === key ? null : key))
    }
    const cancel = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const runIssueAction = async (a: IssueAsk): Promise<void> => {
    setAsk(null)
    const r = await work.githubIssueAction(project.id, a.issue.number, a.kind === 'comment' ? { kind: 'comment', body: a.body } : { kind: a.kind })
    setNotice(r.ok ? { ok: true, text: `${a.kind === 'comment' ? 'Commented on' : a.kind === 'close' ? 'Closed' : 'Reopened'} #${a.issue.number}.` } : { ok: false, text: r.error })
    if (r.ok) void loadIssues()
  }

  const startWork = async (s: StartAsk): Promise<void> => {
    setStart(null)
    const r = await work.startIssueAgent({ projectId: project.id, number: s.issue.number, prompt: s.prompt, title: `#${s.issue.number} ${s.issue.title}`.slice(0, 60), worktreeBranch: s.worktree ? s.branch.trim() : undefined })
    if (!r.ok) {
      setNotice({ ok: false, text: r.error })
      return
    }
    const key = issueKey(s.issue.number)
    change((b) => ({ ...moveCard(moveCard(b, key, s.column), r.nodeId, s.column), started: { ...b.started, [key]: r.nodeId } }))
    setNotice({ ok: true, text: `Started a Claude session on #${s.issue.number}.` })
  }

  const askRemove = (id: string): void => {
    const col = board.columns.find((c) => c.id === id)
    const removal = removeColumn(board, id, allKeys)
    if (!col) return
    void confirmThen(
      {
        title: `Remove "${col.title}"?`,
        message: removal.moved ? `Its ${removal.moved === 1 ? 'card moves' : `${removal.moved} cards move`} to "${board.columns.find((c) => c.id === removal.movedTo)?.title}". Sessions keep running.` : 'It has no cards.',
        verb: 'Remove column',
        attrs: { 'data-board-confirm': 'remove-column' },
        verbAttrs: { 'data-col-tool': 'confirm-remove' }
      },
      () => change((b) => removeColumn(b, id, allKeys).board)
    )
  }
  const repoValue = repoDraft ?? board.issues?.repo ?? ''

  return (
    <Panel
      kind="view"
      title={project.name}
      icon="board"
      label={`Board for ${project.name}`}
      className={`board${drag ? ' board-dragging' : ''}`}
      closeLabel="Back to the canvas"
      onClose={close}
      initialFocus="panel"
      flush
      attrs={{ 'data-board': project.id }}
      sub={
        <>
            <div className="sidebar-tabs board-filter" role="tablist" aria-label="Show">
              {(['all', 'sessions', 'issues'] as const).map((f) => (
                <button key={f} type="button" role="tab" aria-selected={filter === f} data-board-filter={f} className={`sidebar-tab${filter === f ? ' sidebar-tab-on' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'sessions' ? 'Sessions' : 'Issues'}
                </button>
              ))}
            </div>
            <label className="board-issues-toggle" title="Show this project's GitHub issues as cards, read with your own signed-in gh">
              <input type="checkbox" data-board="issues-enabled" checked={enabled} onChange={(e) => change((b) => ({ ...b, issues: { ...b.issues, enabled: e.target.checked } }))} />
              GitHub issues
            </label>
            {enabled && (
              <>
                <input
                  className="board-repo"
                  aria-label="GitHub repository, owner/name"
                  placeholder={issues?.repo ?? 'From the git origin'}
                  value={repoValue}
                  onChange={(e) => setRepoDraft(e.target.value)}
                  onBlur={() => {
                    if (repoDraft === null) return
                    const repo = repoDraft.trim()
                    setRepoDraft(null)
                    change((b) => ({ ...b, issues: { enabled: true, ...(repo ? { repo } : {}) } }))
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                <button type="button" className="btn btn-sm" data-board="refresh-issues" disabled={loading} onClick={() => void loadIssues()}>
                  {loading ? 'Reading…' : 'Refresh'}
                </button>
              </>
            )}
        </>
      }
    >
      {issueError && enabled && <p className="git-output git-output-bad board-note" role="alert">{issueError}</p>}
      {notice && (
        <p className={`git-output board-note${notice.ok ? '' : ' git-output-bad'}`} role="status" data-board-notice>
          {notice.text}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}><Icon name="close" size={13} /></button>
        </p>
      )}
      <TaskOutcomes records={project.tasks} />
      <div className="board-columns">
        {board.columns.map((col, i) => (
          <div key={col.id} className={`board-column${drag?.over === col.id ? ' board-column-over' : ''}`} data-column={col.id}>
            <div className="board-column-head">
              {renaming === col.id ? (
                <input
                  autoFocus
                  aria-label="Column name"
                  defaultValue={col.title}
                  onBlur={(e) => {
                    change((b) => renameColumn(b, col.id, e.target.value))
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <h3 onDoubleClick={() => setRenaming(col.id)} title="Double-click to rename">
                  {col.title} <span className="sidebar-count">{byColumn[col.id].length}</span>
                </h3>
              )}
              <span className="board-column-tools">
                <button type="button" className={`btn btn-sm btn-quiet${col.startsWork ? ' board-starts-on' : ''}`} data-col-tool="starts-work" aria-pressed={!!col.startsWork} title={col.startsWork ? 'Dropping an issue here offers to start a Claude session on it. Click to stop that' : 'Click so that dropping an issue here offers to start a Claude session on it'} onClick={() => change((b) => setStartsWork(b, col.id, !col.startsWork))}>
                  ▶
                </button>
                <button type="button" className="btn btn-sm btn-quiet" data-col-tool="rename" title="Rename" onClick={() => setRenaming(col.id)}>✎</button>
                <button type="button" className="btn btn-sm btn-quiet" data-col-tool="left" title="Move left" disabled={i === 0} onClick={() => change((b) => moveColumn(b, col.id, -1))}>←</button>
                <button type="button" className="btn btn-sm btn-quiet" data-col-tool="right" title="Move right" disabled={i === board.columns.length - 1} onClick={() => change((b) => moveColumn(b, col.id, 1))}>→</button>
                <button type="button" className="btn btn-sm btn-quiet btn-risky" data-col-tool="remove" title="Remove column" disabled={board.columns.length === 1} onClick={() => askRemove(col.id)}>×</button>
              </span>
            </div>
            <ul className="board-cards">
              {byColumn[col.id].map((key) => {
                const node = nodeById.get(key)
                const issue = issueByKey.get(key)
                const agentId = board.started?.[key]
                return (
                  <li
                    key={key}
                    className={`board-card${node ? '' : ' board-card-issue'}${drag?.key === key ? ' board-card-lifted' : ''}`}
                    data-card={key}
                    tabIndex={0}
                    onPointerDown={(e) => onCardDown(e, key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && node) {
                        close()
                        commands.revealNode(key)
                      }
                    }}
                    title={node ? 'Click to go to this session. Drag to another column' : 'Click for details. Drag to another column'}
                  >
                    {node && <SessionCard node={node} />}
                    {issue && <IssueCard issue={issue} open={openIssue === key} agent={agentId ? (nodeById.get(agentId)?.title ?? 'closed') : null} onAsk={(kind) => setAsk({ issue, kind, body: '' })} />}
                  </li>
                )
              })}
              {byColumn[col.id].length === 0 && <li className="board-empty">Drop cards here.</li>}
            </ul>
          </div>
        ))}
        <form
          className="board-column board-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (!adding.trim()) return
            change((b) => addColumn(b, crypto.randomUUID(), adding))
            setAdding('')
          }}
        >
          <input aria-label="New column name" placeholder="New column" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button type="submit" className="btn btn-sm" data-board="add-column" disabled={!adding.trim()}>Add column</button>
        </form>
      </div>
      {drag && (
        <div className="board-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {nodeById.get(drag.key)?.title ?? `#${issueByKey.get(drag.key)?.number ?? ''}`}
        </div>
      )}
      {ask && (
        <Panel
          kind="modal"
          title={ask.kind === 'comment' ? `Comment on #${ask.issue.number}` : `${ask.kind === 'close' ? 'Close' : 'Reopen'} #${ask.issue.number}?`}
          label="Write to GitHub?"
          className="board-dialog"
          onClose={() => setAsk(null)}
          attrs={{ role: 'alertdialog', 'data-board-dialog': 'issue-action' }}
          footer={
            <>
              <button type="button" className="btn" data-board="cancel-write" onClick={() => setAsk(null)}>Cancel</button>
              <button type="button" className={`btn ${ask.kind === 'comment' ? 'btn-solid' : 'btn-danger'}`} data-board="confirm-write" disabled={ask.kind === 'comment' && !ask.body.trim()} onClick={() => void runIssueAction(ask)}>
                {ask.kind === 'comment' ? 'Post comment' : ask.kind === 'close' ? 'Close issue' : 'Reopen issue'}
              </button>
            </>
          }
        >
          <p>
            This writes to GitHub as you, on {issues?.repo}: {ask.kind === 'comment' ? 'the comment below is posted publicly where the issue can be seen.' : `issue #${ask.issue.number} "${ask.issue.title}" will be ${ask.kind === 'close' ? 'closed' : 'reopened'}.`}
          </p>
          {ask.kind === 'comment' && <textarea aria-label="Comment" data-own-esc="" rows={5} value={ask.body} onChange={(e) => setAsk({ ...ask, body: e.target.value })} autoFocus />}
        </Panel>
      )}
      {start && (
        <Panel
          kind="modal"
          title={`Start Claude on #${start.issue.number}?`}
          label="Start a Claude session on this issue?"
          className="board-dialog board-dialog-wide"
          onClose={() => setStart(null)}
          attrs={{ 'data-board-dialog': 'start-work' }}
          footer={
            <>
              <button type="button" className="btn" data-board="cancel-start" onClick={() => setStart(null)}>Cancel</button>
              <button type="button" className="btn btn-solid" data-board="confirm-start" disabled={!!claudeOff || (start.worktree && !start.branch.trim())} onClick={() => void startWork(start)}>Start session</button>
            </>
          }
        >
          <p>A Claude session opens in {start.worktree ? `a new worktree on branch "${start.branch}"` : `the project's folder`} with exactly this prompt. The issue's text is fenced as untrusted.</p>
          <pre className="board-prompt" data-board="prompt">{start.prompt}</pre>
          {claudeOff && <p className="field-problem" role="alert">{claudeOff}</p>}
          <label className="board-worktree">
            <input type="checkbox" data-board="worktree" checked={start.worktree} onChange={(e) => setStart({ ...start, worktree: e.target.checked })} /> In a new worktree group, on branch
            <input aria-label="Branch name" value={start.branch} disabled={!start.worktree} onChange={(e) => setStart({ ...start, branch: e.target.value })} />
          </label>
        </Panel>
      )}
    </Panel>
  )
}
