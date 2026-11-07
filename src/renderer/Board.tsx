import { useCallback, useEffect, useRef, useState } from 'react'
import { addColumn, cardsByColumn, columnOf, defaultBoard, issueKey, moveCard, moveColumn, removeColumn, renameColumn, setStartsWork, type Board as BoardModel, type CardFilter } from '../shared/board'
import type { GithubIssue } from '../shared/git'
import { issuePrompt } from '../shared/issuePrompt'
import { isSessionNode, type SessionNode } from '../shared/model'
import { Icon, KindIcon } from './icons'
import type { Commands } from './menus'
import { runDot, runLabel } from './nodes/runView'
import { StatusBadge, StatusDot } from './nodes/StatusBadge'
import { dispatch, useStore } from './store'
import { contextLabel } from './usageView'
import { work } from './workBridge'
import './work.css'

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
  return (
    <>
      <span className="card-top">
        <StatusDot status={node.kind === 'run' ? runDot(run) : status} />
        <KindIcon kind={node.kind} agent={node.kind === 'claude' ? node.agent : undefined} />
        <span className="card-title">{node.title}</span>
      </span>
      <span className="card-meta">
        {status && <StatusBadge status={status} />}
        {node.kind === 'run' && <span className="run-label">{runLabel(run)}</span>}
        {context && <span className={`session-context usage-${context.level}`}>{context.text}</span>}
      </span>
      <span className="card-where">{node.cwd || 'Home folder'}</span>
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
            <button type="button" className="git-mini" data-issue-tool="open" onClick={() => void work.openGithubPage(issue.url)}>Open on GitHub</button>
            {issue.state === 'OPEN' ? (
              <button type="button" className="git-mini" data-issue-tool="close" onClick={() => onAsk('close')}>Close…</button>
            ) : (
              <button type="button" className="git-mini" data-issue-tool="reopen" onClick={() => onAsk('reopen')}>Reopen…</button>
            )}
            <button type="button" className="git-mini" data-issue-tool="comment" onClick={() => onAsk('comment')}>Comment…</button>
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
  const [removing, setRemoving] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [ask, setAsk] = useState<IssueAsk | null>(null)
  const [start, setStart] = useState<StartAsk | null>(null)
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || (e.target as Element | null)?.closest?.('input, textarea, .xterm')) return
      if (start || ask) {
        setStart(null)
        setAsk(null)
      } else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [start, ask, close])

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

  const target = removing ? board.columns.find((c) => c.id === removing) : undefined
  const removal = removing ? removeColumn(board, removing, allKeys) : null
  const repoValue = repoDraft ?? board.issues?.repo ?? ''

  return (
    <section className={`board${drag ? ' board-dragging' : ''}`} aria-label={`Board for ${project.name}`} data-board={project.id}>
      <header className="board-head">
        <h2>
          <Icon name="board" size={16} /> {project.name}
        </h2>
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
            <button type="button" className="git-btn" data-board="refresh-issues" disabled={loading} onClick={() => void loadIssues()}>
              {loading ? 'Reading…' : 'Refresh'}
            </button>
          </>
        )}
        <span className="git-spacer" />
        <button type="button" className="icon-btn" aria-label="Back to the canvas" title="Back to the canvas (Esc)" onClick={close}>
          ×
        </button>
      </header>
      {issueError && enabled && <p className="git-output git-output-bad board-note" role="alert">{issueError}</p>}
      {notice && (
        <p className={`git-output board-note${notice.ok ? '' : ' git-output-bad'}`} role="status" data-board-notice>
          {notice.text}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </p>
      )}
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
                <button type="button" className={`git-mini${col.startsWork ? ' board-starts-on' : ''}`} data-col-tool="starts-work" aria-pressed={!!col.startsWork} title={col.startsWork ? 'Dropping an issue here offers to start a Claude session on it. Click to stop that' : 'Click so that dropping an issue here offers to start a Claude session on it'} onClick={() => change((b) => setStartsWork(b, col.id, !col.startsWork))}>
                  ▶
                </button>
                <button type="button" className="git-mini" data-col-tool="rename" title="Rename" onClick={() => setRenaming(col.id)}>✎</button>
                <button type="button" className="git-mini" data-col-tool="left" title="Move left" disabled={i === 0} onClick={() => change((b) => moveColumn(b, col.id, -1))}>←</button>
                <button type="button" className="git-mini" data-col-tool="right" title="Move right" disabled={i === board.columns.length - 1} onClick={() => change((b) => moveColumn(b, col.id, 1))}>→</button>
                <button type="button" className="git-mini git-mini-danger" data-col-tool="remove" title="Remove column" disabled={board.columns.length === 1} onClick={() => setRemoving(col.id)}>×</button>
              </span>
            </div>
            {removing === col.id && removal && target && (
              <div className="git-confirm" role="alertdialog" aria-label="Remove column?">
                <p>
                  Remove "{target.title}"?{' '}
                  {removal.moved ? `Its ${removal.moved === 1 ? 'card moves' : `${removal.moved} cards move`} to "${board.columns.find((c) => c.id === removal.movedTo)?.title}". Sessions keep running.` : 'It has no cards.'}
                </p>
                <div className="git-confirm-row">
                  <button type="button" className="git-btn git-btn-danger" data-col-tool="confirm-remove" onClick={() => {
                    change((b) => removeColumn(b, col.id, allKeys).board)
                    setRemoving(null)
                  }}>Remove</button>
                  <button type="button" className="git-btn" onClick={() => setRemoving(null)}>Cancel</button>
                </div>
              </div>
            )}
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
          <button type="submit" className="git-btn" data-board="add-column" disabled={!adding.trim()}>Add column</button>
        </form>
      </div>
      {drag && (
        <div className="board-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {nodeById.get(drag.key)?.title ?? `#${issueByKey.get(drag.key)?.number ?? ''}`}
        </div>
      )}
      {ask && (
        <div className="board-dialog" role="alertdialog" aria-label="Write to GitHub?" data-board-dialog="issue-action">
          <h3>{ask.kind === 'comment' ? `Comment on #${ask.issue.number}` : `${ask.kind === 'close' ? 'Close' : 'Reopen'} #${ask.issue.number}?`}</h3>
          <p>
            This writes to GitHub as you, on {issues?.repo}: {ask.kind === 'comment' ? 'the comment below is posted publicly where the issue can be seen.' : `issue #${ask.issue.number} "${ask.issue.title}" will be ${ask.kind === 'close' ? 'closed' : 'reopened'}.`}
          </p>
          {ask.kind === 'comment' && <textarea aria-label="Comment" rows={5} value={ask.body} onChange={(e) => setAsk({ ...ask, body: e.target.value })} autoFocus />}
          <div className="git-confirm-row">
            <button type="button" className="git-btn git-btn-danger" data-board="confirm-write" disabled={ask.kind === 'comment' && !ask.body.trim()} onClick={() => void runIssueAction(ask)}>
              {ask.kind === 'comment' ? 'Post comment' : ask.kind === 'close' ? 'Close issue' : 'Reopen issue'}
            </button>
            <button type="button" className="git-btn" data-board="cancel-write" onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </div>
      )}
      {start && (
        <div className="board-dialog board-dialog-wide" role="alertdialog" aria-label="Start a Claude session on this issue?" data-board-dialog="start-work">
          <h3>Start Claude on #{start.issue.number}?</h3>
          <p>A Claude session opens in {start.worktree ? `a new worktree on branch "${start.branch}"` : `the project's folder`} with exactly this prompt. The issue's text is fenced as untrusted.</p>
          <pre className="board-prompt" data-board="prompt">{start.prompt}</pre>
          <label className="board-worktree">
            <input type="checkbox" data-board="worktree" checked={start.worktree} onChange={(e) => setStart({ ...start, worktree: e.target.checked })} /> In a new worktree group, on branch
            <input aria-label="Branch name" value={start.branch} disabled={!start.worktree} onChange={(e) => setStart({ ...start, branch: e.target.value })} />
          </label>
          <div className="git-confirm-row">
            <button type="button" className="git-btn git-btn-main" data-board="confirm-start" disabled={start.worktree && !start.branch.trim()} onClick={() => void startWork(start)}>Start session</button>
            <button type="button" className="git-btn" data-board="cancel-start" onClick={() => setStart(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}
