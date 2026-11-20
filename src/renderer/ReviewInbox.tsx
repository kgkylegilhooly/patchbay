import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  fixesPending,
  placementText,
  reviewEvidence,
  shownLine,
  type ChangedFile,
  type ChangeRange,
  type ChangeSection,
  type ChangeSet,
  type CommentView,
  type InboxItem,
  type ReviewSide,
  type Shown
} from '../shared/reviewInbox'
import { bridge } from './bridge'
import { Icon } from './icons'
import { noteTarget, parseDiff, type DiffLine } from './reviewNotes'
import { ago, closeReviewInbox, commentsByLine, reviewBridge, useReviewInbox } from './reviewInboxUi'
import { useStore } from './store'
import { TaskComparisons } from './tasks/TaskComparisons'
import './reviewInbox.css'

const short = (oid: string | null | undefined): string => (oid ? oid.slice(0, 7) : '—')
const SECTION: Record<ChangeSection, { title: string; help: string }> = {
  committed: { title: 'Committed on this branch', help: 'In commits since the merge-base with the base branch.' },
  local: { title: 'Local, not committed', help: 'In the working folder only, untracked files included. Not in any commit yet.' },
  'since-review': { title: 'Changed since your last review', help: 'Compared with the snapshot recorded at your last review, uncommitted changes included.' }
}
const STATE_LABEL = { 'ready-for-review': 'submitted', blocked: 'submitted, not ready' } as Record<string, string>
/** Diff lines drawn at first; more on request, so a huge diff never stalls the window. */
const PAGE_LINES = 1500

/** The review inbox, over the canvas or the board, when open. */
export function ReviewInboxLayer(): React.JSX.Element | null {
  const open = useReviewInbox((s) => s.open)
  return open ? <ReviewInbox /> : null
}

function ReviewInbox(): React.JSX.Element {
  const projectId = useStore((s) => s.doc?.activeProjectId ?? '')
  // What the queue depends on: each task's state, submission and number of attempts. Not every progress tick.
  const signature = useStore((s) => {
    const records = s.doc?.projects.find((p) => p.id === s.doc?.activeProjectId)?.tasks
    return records ? records.tasks.map((t) => `${t.id}:${t.state}:${t.submissionId ?? ''}:${records.attempts.filter((a) => a.taskId === t.id).length}`).join('|') : ''
  })
  const chosen = useReviewInbox((s) => s.taskId)
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const r = await reviewBridge().inbox(projectId)
    if (r.ok) { setItems(r.value); setError('') } else setError(r.error)
  }, [projectId])
  useEffect(() => { void load() }, [load, signature])
  useEffect(() => {
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement)) closeReviewInbox() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const selected = items?.find((i) => i.view.task.id === chosen) ?? items?.[0]
  return (
    // "drawer" too, so canvas shortcuts such as Esc to zoom back leave it to the inbox.
    <div className="rvi drawer" role="dialog" aria-label="Review inbox">
      <header className="drawer-head rvi-head">
        <h2>Review inbox</h2>
        <span className="rvi-sub">Submitted task work, its changes, and your comments. Comments are saved.</span>
        <button className="git-mini" onClick={() => void load()}>Refresh</button>
        <button className="icon-btn" aria-label="Close the review inbox" onClick={closeReviewInbox}><Icon name="close" size={16} /></button>
      </header>
      <div className="rvi-body">
        {/* Empty: one message across the whole view, not a sentence in the queue beside a blank pane. */}
        {items?.length === 0 && !error ? (
          <div className="rvi-empty">
            <h3>Nothing is waiting for review</h3>
            <p>When an agent finishes a task, its changes and checks land here for you to accept or send back for fixes.</p>
            <p className="rvi-dim">Agents submit with <code>patchbay task submit</code>.</p>
          </div>
        ) : (<>
        <nav className="rvi-queue" aria-label="Waiting for review">
          {error && <p className="rvi-error" role="alert">{error}</p>}
          {items === null && !error && <p className="drawer-empty">Loading…</p>}
          {items?.map((item) => {
            const t = item.view.task
            return (
              <button key={t.id} className={`rvi-item${selected?.view.task.id === t.id ? ' rvi-item-on' : ''}`} data-review-task={t.id} onClick={() => useReviewInbox.setState({ taskId: t.id })}>
                <strong>{t.brief}</strong>
                <span className="rvi-item-meta">
                  <span className={item.view.readiness.ready ? 'rvi-pill rvi-ok' : 'rvi-pill rvi-warn'}>{item.view.readiness.ready ? 'ready' : STATE_LABEL[t.state] ?? t.state}</span>
                  {item.branch && <span className="rvi-branch"><Icon name="branch" size={12} /> {item.branch}</span>}
                  {item.openComments > 0 && <span className="rvi-pill">{item.openComments} open</span>}
                  {fixesPending(item.view, item.lastReview) && <span className="rvi-pill rvi-warn">fixes requested</span>}
                </span>
                <span className="rvi-item-agents">{item.attribution.assigned.join(', ') || 'No agent assigned'}</span>
              </button>
            )
          })}
        </nav>
        {selected ? <ReviewItem key={selected.view.task.id} item={selected} onChanged={load} /> : <div className="rvi-detail" />}
        </>)}
      </div>
    </div>
  )
}

function Evidence({ item }: { item: InboxItem }): React.JSX.Element {
  const evidence = reviewEvidence(item.view)
  const report = evidence.find((e) => e.source === 'agent-report')
  const commands = evidence.filter((e) => e.source === 'command')
  const browsers = evidence.filter((e) => e.source === 'browser')
  const ci = evidence.find((e) => e.source === 'ci')
  const nodeTitle = (id: string): string => useStore.getState().doc?.nodes.find((n) => n.id === id)?.title ?? 'a closed browser'
  return (
    <section className="rvi-section" aria-label="Evidence">
      {report?.source === 'agent-report' && (
        <div className="rvi-report">
          <span className="rvi-label">{report.label} · {ago(report.at)}</span>
          <p>{report.summary}</p>
        </div>
      )}
      <div className="rvi-checks">
        <span className="rvi-label">Command runs recorded by Patchbay</span>
        {commands.length === 0 && <p className="rvi-dim">No checks were declared for this task.</p>}
        <ul>
          {commands.map((c) => c.source === 'command' && (
            <li key={c.checkId} data-check-state={c.state}>
              <span className={`rvi-pill rvi-check-${c.state.replace(' ', '-')}`}>{c.state}</span>
              <strong>{c.checkId}</strong> <code>{c.command}</code>
              <span className="rvi-dim">{c.detail}</span>
            </li>
          ))}
        </ul>
        {browsers.length > 0 && (
          <>
            <span className="rvi-label rvi-label-gap">Browser checks recorded by the agent (its claim, not proof)</span>
            <ul>
              {browsers.map((b, i) => b.source === 'browser' && (
                <li key={i} data-browser-check={b.assertion}>
                  <span className="rvi-pill">{b.assertion === 'unknown' ? 'no verdict' : `claims ${b.assertion}`}</span>
                  <code>{b.url}</code>
                  <span className="rvi-dim">{b.state}{b.gaps ? `, ${b.gaps} ${b.gaps === 1 ? 'gap' : 'gaps'}` : ''} · in {nodeTitle(b.nodeId)}'s Evidence panel · {ago(b.at)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {ci && <p className="rvi-ci" data-ci="unavailable"><span className="rvi-pill">CI unavailable</span> <span className="rvi-dim">{ci.detail}</span></p>}
      </div>
    </section>
  )
}

interface ShownDiff { file: ChangedFile; range: ChangeRange; text: string; truncated: boolean }

function ReviewItem({ item, onChanged }: { item: InboxItem; onChanged: () => Promise<void> }): React.JSX.Element {
  const task = item.view.task
  const [mode, setMode] = useState<'branch' | 'since-review'>('branch')
  const [base, setBase] = useState(item.base ?? '')
  const [bases, setBases] = useState<string[]>([])
  const [changes, setChanges] = useState<ChangeSet | null>(null)
  const [comments, setComments] = useState<CommentView[]>([])
  const [shown, setShown] = useState<ShownDiff | null>(null)
  const [problem, setProblem] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [to, setTo] = useState(item.agents[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const call = async <T,>(p: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T | null> => {
    const r = await p
    if (!r.ok) { setResult({ ok: false, text: r.error }); return null }
    return r.value
  }
  /** What the person is looking at: the review actions are about this, not the files at the moment of the click. */
  const reviewed = (c: ChangeSet | null): Shown | null => (c ? { tree: c.tree, head: c.head, ...(c.base ? { base: c.base.name, mergeBase: c.base.mergeBase } : {}) } : null)
  const reloadComments = useCallback(async (tree?: string) => {
    const r = await reviewBridge().comments(task.projectId, task.id, tree)
    if (r.ok) setComments(r.value)
  }, [task.projectId, task.id])
  const loadChanges = useCallback(async () => {
    setProblem('')
    if (mode === 'branch' && !base) { setChanges(null); setProblem('Choose a base branch to compare with.'); return }
    const r = await reviewBridge().changes(task.projectId, task.id, mode === 'branch' ? { kind: 'branch', base } : { kind: 'since-review' })
    if (r.ok) setChanges(r.value)
    else { setChanges(null); setProblem(r.error) }
    setShown(null)
    // The comments are placed against the same snapshot, so it's taken once.
    await reloadComments(r.ok ? r.value.tree : undefined)
    // Files may have changed since the queue was read, so its readiness is read again with them.
    void onChanged()
  }, [mode, base, task.projectId, task.id, reloadComments, onChanged])
  useEffect(() => { void loadChanges() }, [loadChanges])
  useEffect(() => { void reviewBridge().branches(task.projectId, task.id).then((r) => r.ok && setBases(r.value)) }, [task.projectId, task.id])

  const open = async (file: ChangedFile): Promise<void> => {
    const range = changes?.ranges[file.section]
    if (!range) return
    const d = await call(reviewBridge().fileDiff(task.projectId, task.id, range, file.path))
    if (d) setShown({ file, range, ...d })
  }
  const addComment = useCallback(async (path: string, side: ReviewSide, line: number, revision: string, section: ChangeSection, text: string): Promise<boolean> => {
    const base = section === 'committed' ? changes?.base?.name : undefined
    const r = await reviewBridge().addComment(task.projectId, task.id, { path, side, line, revision, text, section, ...(base ? { base } : {}) })
    if (!r.ok) { setResult({ ok: false, text: r.error }); return false }
    await reloadComments(changes?.tree)
    void onChanged()
    return true
  }, [task.projectId, task.id, changes, reloadComments, onChanged])
  const setStatus = async (c: CommentView, status: 'open' | 'resolved'): Promise<void> => {
    if (await call(reviewBridge().setCommentStatus(task.projectId, c.id, status))) { await reloadComments(changes?.tree); void onChanged() }
  }
  const remove = async (c: CommentView): Promise<void> => {
    if (await call(reviewBridge().deleteComment(task.projectId, c.id))) { await reloadComments(changes?.tree); void onChanged() }
  }
  const changedNote = (changed: boolean): string => (changed ? ' Files changed after you loaded these changes; they will show under Since last review.' : '')
  const requestFixes = async (): Promise<void> => {
    setBusy(true)
    const r = await call(reviewBridge().requestFixes(task.projectId, task.id, to, reviewed(changes)))
    setBusy(false)
    if (!r) return
    setResult({ ok: true, text: `${r.sent} comment${r.sent === 1 ? '' : 's'} ${r.queued ? `queued for ${r.to}; it goes out when the agent is idle` : `sent to ${r.to}`}.${r.recorded ? ' What you were looking at is recorded as reviewed.' : " The reviewed revision couldn't be recorded."}${changedNote(r.changedSince)}` })
    await reloadComments(changes?.tree)
    void onChanged()
  }
  const markReviewed = async (): Promise<void> => {
    const shownNow = reviewed(changes)
    if (!shownNow) return
    const r = await call(reviewBridge().markReviewed(task.projectId, task.id, shownNow))
    if (r) { setResult({ ok: true, text: `Recorded as reviewed: ${short(r.mark.head)}, snapshot ${short(r.mark.tree)}.${changedNote(r.changedSince)}` }); void onChanged() }
  }
  const unresolved = comments.filter((c) => c.state !== 'resolved')
  const pending = fixesPending(item.view, item.lastReview)
  const accept = async (anyway = false): Promise<void> => {
    if (!task.submissionId) return
    // Acceptance stays the person's; with feedback still open, they say so first.
    if (!anyway && (unresolved.length > 0 || pending)) { setConfirming(true); return }
    setConfirming(false)
    setBusy(true)
    try { await bridge.taskAccept(task.projectId, task.id, task.submissionId); setResult({ ok: true, text: 'Accepted.' }); void onChanged() }
    catch (e) { setResult({ ok: false, text: String(e instanceof Error ? e.message : e) }) }
    finally { setBusy(false) }
  }
  const agentName = item.agents.find((a) => a.id === to)?.title ?? 'the agent'

  const sections = (['committed', 'local', 'since-review'] as ChangeSection[]).filter((s) => changes?.ranges[s])
  return (
    <div className="rvi-detail" data-review-detail={task.id}>
      <section className="rvi-section">
        <h3 className="rvi-brief">{task.brief}</h3>
        <ul className="rvi-criteria">{task.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
        <p className="rvi-checkout">
          {item.root ? <><Icon name="branch" size={13} /> <strong>{item.branch ?? 'detached HEAD'}</strong> at <code>{short(item.head)}</code> in <code>{item.root}</code></> : <span className="rvi-error">{item.error}</span>}
        </p>
        <p className={item.attribution.sole ? 'rvi-dim' : 'rvi-shared'} data-attribution={item.attribution.sole ? 'sole' : 'shared'}>{item.attribution.note}</p>
        {!item.view.readiness.ready && <p className="rvi-warn-text">Not ready to accept: {item.view.readiness.reasons.join('; ')}</p>}
        {item.view.readiness.warnings.length > 0 && <p className="rvi-dim">{item.view.readiness.warnings.join('; ')}</p>}
      </section>
      <Evidence item={item} />
      {item.view.attempts.some((a) => a.kind === 'comparison') && <section className="rvi-section" aria-label="Comparisons"><TaskComparisons attempts={item.view.attempts} /></section>}
      <section className="rvi-section rvi-changes" aria-label="Changes">
        <div className="rvi-toolbar">
          <div className="rvi-modes" role="tablist">
            <button role="tab" aria-selected={mode === 'branch'} className={mode === 'branch' ? 'rvi-mode rvi-mode-on' : 'rvi-mode'} onClick={() => setMode('branch')}>Branch vs base</button>
            <button role="tab" aria-selected={mode === 'since-review'} className={mode === 'since-review' ? 'rvi-mode rvi-mode-on' : 'rvi-mode'} disabled={!item.lastReview} title={item.lastReview ? undefined : 'Mark reviewed or request fixes first'} onClick={() => setMode('since-review')}>Since last review</button>
          </div>
          {mode === 'branch' && (
            <label className="rvi-base">Base <select aria-label="Base branch" value={base} onChange={(e) => setBase(e.target.value)}>
              {!base && <option value="">Choose…</option>}
              {[...new Set([base, ...bases].filter(Boolean))].map((b) => <option key={b} value={b}>{b}</option>)}
            </select></label>
          )}
          <button className="git-mini" onClick={() => void loadChanges()}>Refresh changes</button>
        </div>
        {changes && (
          <p className="rvi-dim rvi-compare" data-compare={mode}>
            {mode === 'branch' && changes.base ? <>Comparing with <strong>{changes.base.name}</strong> at <code>{short(changes.base.oid)}</code>, from merge-base <code>{short(changes.base.mergeBase)}</code>.</> : null}
            {mode === 'since-review' && changes.review ? <>Comparing with what you reviewed {ago(changes.review.at)} ({changes.review.reason === 'fixes-requested' ? 'when you requested fixes' : 'marked reviewed'}): <code>{short(changes.review.head)}</code>, snapshot <code>{short(changes.review.tree)}</code>.</> : null}
          </p>
        )}
        {changes?.notes.map((n, i) => <p key={i} className="rvi-note">{n}</p>)}
        {problem && <p className="rvi-error">{problem}</p>}
        {sections.map((s) => {
          const files = changes!.files.filter((f) => f.section === s)
          return (
            <div key={s} className={`rvi-files rvi-files-${s}`} data-section={s}>
              <span className="rvi-label" title={SECTION[s].help}>{SECTION[s].title} · {files.length} file{files.length === 1 ? '' : 's'}</span>
              {files.length === 0 && <p className="rvi-dim">None.</p>}
              {files.map((f) => {
                const count = unresolved.filter((c) => c.anchor.path === f.path).length
                const on = shown?.file.path === f.path && shown.file.section === s
                return (
                  <button key={f.path} className={`rvi-file${on ? ' rvi-file-on' : ''}`} data-review-file={f.path} onClick={() => void open(f)}>
                    <span className={`rvi-status rvi-status-${f.status}`}>{f.status}</span>
                    <span className="rvi-path">{f.path}</span>
                    {s === 'local' && <span className="rvi-pill rvi-local">uncommitted</span>}
                    {count > 0 && <span className="rvi-pill">{count}</span>}
                  </button>
                )
              })}
            </div>
          )
        })}
        {shown && changes && <InboxDiff key={`${shown.file.section}:${shown.file.path}:${shown.range.to}`} shown={shown} changes={changes} comments={comments} onAdd={addComment} />}
      </section>
      <section className="rvi-section" aria-label="Comments">
        <span className="rvi-label">Comments · {unresolved.length} unresolved of {comments.length}</span>
        {comments.length === 0 && <p className="rvi-dim">No comments yet. Open a file and use + on a line.</p>}
        <ul className="rvi-comments">
          {comments.map((c) => (
            <li key={c.id} className={`rvi-comment rvi-comment-${c.state}`} data-comment-state={c.state}>
              <span className={`rvi-pill rvi-state-${c.state}`}>{c.state}</span>
              <span className="rvi-where"><code>{c.anchor.path}</code> {placementText(c.placement, c.anchor.side)}</span>
              <code className="rvi-snippet">{shownLine(c.anchor.snippet).trim()}</code>
              <span className="rvi-text">{c.text}</span>
              <span className="rvi-comment-meta">Written {ago(c.createdAt)} on {c.anchor.revisionKind === 'commit' ? 'commit' : 'snapshot'} <code>{short(c.anchor.revision)}</code>{c.sentAt ? ` · sent ${ago(c.sentAt)}` : ''}</span>
              <span className="rvi-comment-actions">
                {c.status === 'open' ? <button className="git-mini" onClick={() => void setStatus(c, 'resolved')}>Resolve</button> : <button className="git-mini" onClick={() => void setStatus(c, 'open')}>Reopen</button>}
                <button className="git-mini" aria-label="Delete this comment" onClick={() => void remove(c)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <footer className="rvi-actions">
        {item.agents.length === 0 ? <span className="rvi-dim">No assigned agent is on the canvas to send fixes to.</span> : (
          <>
            <select aria-label="Send fixes to" value={to} onChange={(e) => setTo(e.target.value)}>
              {item.agents.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
            </select>
            <button className="git-btn" data-review="request-fixes" disabled={busy || unresolved.length === 0} onClick={() => void requestFixes()}>Request fixes ({unresolved.length})</button>
          </>
        )}
        <button className="git-btn" data-review="mark" disabled={busy || !changes} title={changes ? 'Record what is shown as reviewed' : 'Load the changes first'} onClick={() => void markReviewed()}>Mark reviewed</button>
        <span className="rvi-spacer" />
        {confirming ? (
          <span className="rvi-confirm" role="alertdialog" aria-label="Accept with feedback open?">
            {[unresolved.length > 0 ? `${unresolved.length} unresolved comment${unresolved.length === 1 ? '' : 's'}` : '', pending ? `fixes requested from ${agentName} after this submission` : ''].filter(Boolean).join('; ')}. Accept anyway?
            <button className="git-mini" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="git-btn git-btn-main" data-review="accept-anyway" disabled={busy} onClick={() => void accept(true)}>Accept anyway</button>
          </span>
        ) : (
          <button className="git-btn git-btn-main" data-review="accept" disabled={busy || !item.view.readiness.ready} title={item.view.readiness.ready ? "Before accepting, Patchbay checks the files haven't changed since the required checks passed." : 'Not ready: see above'} onClick={() => void accept()}>Accept this submission</button>
        )}
      </footer>
      {result && <p className={result.ok ? 'rvi-result' : 'rvi-result rvi-result-bad'} role="status">{result.text} <button className="git-mini" aria-label="Dismiss" onClick={() => setResult(null)}>×</button></p>}
    </div>
  )
}

type Add = (path: string, side: ReviewSide, line: number, revision: string, section: ChangeSection, text: string) => Promise<boolean>

/** The comment box, with its own draft, so typing re-draws only this and never the diff. */
function CommentEditor({ onSave, onCancel }: { onSave: (text: string) => Promise<boolean>; onCancel: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const save = (): void => { if (draft.trim()) void onSave(draft.trim()) }
  return (
    <span className="review-edit">
      <textarea autoFocus aria-label="Review comment" placeholder="What should change here?" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
      }} />
      <span className="review-edit-actions">
        <button type="button" className="git-mini" onClick={onCancel}>Cancel</button>
        <button type="button" className="git-mini review-save" disabled={!draft.trim()} onClick={save}>Add comment</button>
      </span>
      {'\n'}
    </span>
  )
}

/** One diff line with its comments. Redrawn only when its own comments, or whether it's being commented on, change. */
const DiffRow = memo(function DiffRow({ line, index, here, editing, onEdit, onSave, onCancel }: {
  line: DiffLine
  index: number
  here: CommentView[] | undefined
  editing: boolean
  onEdit: (i: number) => void
  onSave: (i: number, text: string) => Promise<boolean>
  onCancel: () => void
}): React.JSX.Element {
  const target = noteTarget(line)
  const cls = line.kind === 'add' ? 'diff-add' : line.kind === 'del' ? 'diff-del' : line.kind === 'hunk' ? 'diff-hunk' : ''
  return (
    <span className="review-line-wrap">
      <span className={`review-line ${cls}`}>
        {target ? <button type="button" className="review-add" data-review-add={index} aria-label={`Comment on ${target.side === 'new' ? 'line' : 'removed line'} ${target.line}`} title="Add a review comment" onClick={() => onEdit(index)}>+</button> : <span className="review-add-gap" />}
        <span className="review-num">{target ? target.line : ''}</span>
        {line.text}
        {'\n'}
      </span>
      {here?.map((c) => (
        <span key={c.id} className={`review-note rvi-inline rvi-inline-${c.state}`} data-review-comment={c.id}>
          <span className="review-note-text">{c.state !== 'open' ? `[${c.state}] ` : ''}{c.text}</span>
          {'\n'}
        </span>
      ))}
      {editing && <CommentEditor onSave={(text) => onSave(index, text)} onCancel={onCancel} />}
    </span>
  )
})

function InboxDiff({ shown, changes, comments, onAdd }: { shown: ShownDiff; changes: ChangeSet; comments: CommentView[]; onAdd: Add }): React.JSX.Element {
  const lines = useMemo(() => parseDiff(shown.text), [shown.text])
  const [editing, setEditing] = useState<number | null>(null)
  const [limit, setLimit] = useState(PAGE_LINES)
  const { path, section } = shown.file
  const localPaths = useMemo(() => new Set(changes.files.filter((f) => f.section === 'local').map((f) => f.path)), [changes.files])
  // The new side is the code as it is now when it's the working folder, or HEAD for a committed file with no local change.
  const currentNew = shown.range.to === changes.tree || (section === 'committed' && shown.range.to === changes.head && !localPaths.has(path))
  // The old side is current when it's what the comment's own list compares from now.
  const currentOld = (section === 'committed' && shown.range.from === changes.base?.mergeBase) || (section === 'local' && shown.range.from === changes.head)
  const byLine = useMemo(() => commentsByLine(comments, { path, section, from: shown.range.from, to: shown.range.to, currentNew, currentOld }), [comments, path, section, shown.range, currentNew, currentOld])
  const save = useCallback(async (i: number, text: string): Promise<boolean> => {
    const target = noteTarget(lines[i])
    if (!target) return false
    const revision = target.side === 'new' ? shown.range.to : shown.range.from
    const ok = await onAdd(path, target.side, target.line, revision, section, text)
    if (ok) setEditing(null)
    return ok
  }, [lines, shown.range, onAdd, path, section])
  const cancel = useCallback(() => setEditing(null), [])
  if (!shown.text.trim()) return <p className="rvi-dim">No text differences in {path} (a mode change, or a binary file).</p>
  return (
    <div className="rvi-diff">
      <div className="rvi-diff-head">
        <code>{path}</code>
        <span className="rvi-dim">{section === 'local' ? 'uncommitted' : section === 'committed' ? 'committed' : 'since last review'} · {short(shown.range.from)} → {shown.range.to === changes.tree ? 'working folder now' : short(shown.range.to)}{shown.truncated ? ' · cut short, too large' : ''}</span>
      </div>
      <pre className="git-diff-text review-diff">
        {lines.slice(0, limit).map((line, i) => {
          const target = noteTarget(line)
          return <DiffRow key={i} line={line} index={i} here={target ? byLine.get(`${target.side}:${target.line}`) : undefined} editing={editing === i} onEdit={setEditing} onSave={save} onCancel={cancel} />
        })}
      </pre>
      {lines.length > limit && <button className="git-mini rvi-more" onClick={() => setLimit((n) => n + PAGE_LINES)}>Show {Math.min(PAGE_LINES, lines.length - limit)} more of {lines.length - limit} lines</button>}
    </div>
  )
}
