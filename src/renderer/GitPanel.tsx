import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BranchInfo, ChangeEntry, CommitRow, DiffResult, GitOutcome, RepoChoice, RepoStatus } from '../shared/git'
import { discardWarning, refChip, repoCandidates, switchWarning } from './gitView'
import { Icon } from './icons'
import { ReviewBar, ReviewDiff } from './ReviewDiff'
import { useStore } from './store'
import { work } from './workBridge'
import './work.css'

type Tab = 'changes' | 'branches' | 'history'
type Confirm = { kind: 'discard'; entries: ChangeEntry[]; text: string } | { kind: 'switch'; branch: string; text: string } | { kind: 'pull-merge' }

const LANE_COLORS = ['#3d8bfd', '#ff9f43', '#34c759', '#bf7af0', '#ff453a', '#49c2c9', '#e6c84a', '#ff6fae']
const ROW = 26
const LANE = 14
/** Focus can come and go quickly. A refresh at most this often is plenty, and spares git. */
const FOCUS_GAP_MS = 2000

function Graph({ row, lanes }: { row: CommitRow; lanes: number }): React.JSX.Element {
  const x = (lane: number): number => lane * LANE + LANE / 2
  return (
    <svg className="git-graph" width={lanes * LANE} height={ROW} aria-hidden="true">
      {row.segments.map((s, i) => (
        <line key={i} x1={x(s.x1)} y1={s.y1 * ROW} x2={x(s.x2)} y2={s.y2 * ROW} stroke={LANE_COLORS[s.lane % LANE_COLORS.length]} strokeWidth="2" />
      ))}
      <circle cx={x(row.col)} cy={ROW / 2} r={row.merge ? 5 : 4} fill={row.merge ? 'var(--face)' : LANE_COLORS[row.col % LANE_COLORS.length]} stroke={LANE_COLORS[row.col % LANE_COLORS.length]} strokeWidth="2" />
    </svg>
  )
}

function Entry({ entry, selected, onSelect, actions }: { entry: ChangeEntry; selected: boolean; onSelect: () => void; actions: React.ReactNode }): React.JSX.Element {
  return (
    <li className={`git-entry${selected ? ' git-entry-on' : ''}`} data-git-entry={`${entry.area}:${entry.path}`}>
      <button type="button" className="git-entry-name" title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path} onClick={onSelect}>
        <span className={`git-letter git-letter-${entry.letter === '?' ? 'new' : entry.letter}`} title={entry.area === 'untracked' ? 'Untracked' : undefined}>
          {entry.letter === '?' ? 'U' : entry.letter}
        </span>
        <span className="git-path">{entry.path}</span>
      </button>
      <span className="git-entry-tools">{actions}</span>
    </li>
  )
}

export function GitPanel({ selected }: { selected: string[] }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const asked = useStore((s) => s.gitFolder)
  const [repos, setRepos] = useState<RepoChoice[] | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('changes')
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [log, setLog] = useState<{ rows: CommitRow[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<{ ok: boolean; text: string; what: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [file, setFile] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<DiffResult | string | null>(null)
  const lastRefresh = useRef(0)
  const inFlight = useRef(false)

  // Which repositories there are, worked out again only when the folders on the canvas change.
  const candidates = useMemo(() => (doc ? repoCandidates(doc, asked ? [] : selected) : []), [doc, asked, selected])
  const candidateKey = (asked ?? '') + candidates.map((c) => c.path).join('|')
  useEffect(() => {
    let live = true
    const list = asked && !candidates.some((c) => c.path === asked) ? [{ path: asked, label: 'Chosen folder' }, ...candidates] : candidates
    const ordered = asked ? [...list.filter((c) => c.path === asked), ...list.filter((c) => c.path !== asked)] : list
    void work.gitRepos(ordered).then((found) => {
      if (!live) return
      setRepos(found)
      setRoot((current) => (asked || !current || !found.some((r) => r.root === current) ? (found[0]?.root ?? null) : current))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey])

  const refresh = useCallback(async (which: Tab = tab) => {
    if (!root || inFlight.current) return
    inFlight.current = true
    lastRefresh.current = Date.now()
    try {
      const [s, b] = await Promise.all([work.gitStatus(root), work.gitBranches(root)])
      if (!s.ok) {
        setError(s.error)
        return
      }
      setError(null)
      setStatus(s.status)
      if (b.ok) setBranches(b.branches)
      if (which === 'history') {
        const l = await work.gitLog(root)
        if (l.ok) setLog({ rows: l.rows, truncated: l.truncated })
        else setError(l.error)
      }
    } finally {
      inFlight.current = false
    }
  }, [root, tab])

  useEffect(() => {
    setStatus(null)
    setLog(null)
    setFile(null)
    setDiff(null)
    setOutput(null)
    setConfirm(null)
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])
  useEffect(() => void refresh(tab), [tab, refresh])

  // Coming back to the window is when files most often changed elsewhere.
  useEffect(() => {
    const onFocus = (): void => {
      if (Date.now() - lastRefresh.current > FOCUS_GAP_MS) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const showDiff = useCallback(async (path: string, staged: boolean) => {
    if (!root) return
    setFile({ path, staged })
    setDiff(null)
    const r = await work.gitDiff(root, path, staged)
    setDiff(r.ok ? r.diff : r.error)
  }, [root])

  const act = async (what: string, run: () => Promise<GitOutcome>, after?: () => void): Promise<void> => {
    if (busy) return
    setBusy(what)
    setConfirm(null)
    try {
      const r = await run()
      setOutput(r.ok ? { ok: true, text: r.output, what } : { ok: false, text: r.error, what })
      if (r.ok) after?.()
    } catch (e) {
      setOutput({ ok: false, text: e instanceof Error ? e.message : String(e), what })
    } finally {
      setBusy(null)
      await refresh()
      if (file) void showDiff(file.path, file.staged)
    }
  }

  if (!doc) return null
  const close = (): void => useStore.setState({ gitOpen: false, gitFolder: null })
  const r = root!
  const tracked = status?.unstaged ?? []
  const lanes = log ? Math.max(1, ...log.rows.map((x) => x.width)) : 1
  const remotes = new Set(branches.filter((b) => b.remote).map((b) => b.name))
  const localNames = new Set(branches.filter((b) => !b.remote).map((b) => b.name))
  const followed = new Set(branches.filter((b) => !b.remote && b.upstream).map((b) => b.upstream))

  const switchTo = (branch: string): void => {
    const warning = status ? switchWarning(status, branch) : null
    if (warning) setConfirm({ kind: 'switch', branch, text: warning })
    else void act(`Switch to ${branch}`, () => work.gitSwitch(r, branch))
  }

  return (
    <aside className="git-panel" aria-label="Git">
      <div className="git-head">
        <h2>
          <Icon name="branch" size={15} /> Git
        </h2>
        <select className="git-repo" aria-label="Repository" value={root ?? ''} onChange={(e) => setRoot(e.target.value || null)} disabled={!repos?.length}>
          {(repos ?? []).map((x) => (
            <option key={x.root} value={x.root}>
              {x.label}: {x.root}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" data-git="refresh" title="Refresh" aria-label="Refresh" onClick={() => void refresh()}>
          <Icon name="refresh" size={14} />
        </button>
        <button type="button" className="icon-btn" aria-label="Hide the git panel" title="Hide the git panel" onClick={close}>
          ×
        </button>
      </div>
      {repos && repos.length === 0 && <p className="git-empty">No git repository here. Set the project's folder, or select a session or worktree group in one.</p>}
      {root && (
        <>
          <div className="git-branchbar">
            <span className="git-current" data-git-branch={status?.branch ?? ''} title={status?.upstream ? `Follows ${status.upstream}` : 'No upstream yet'}>
              {status ? (status.branch ?? `Detached at ${status.oid?.slice(0, 7) ?? '?'}`) : '…'}
            </span>
            {status?.upstream && (
              <span className="git-ab" title={`${status.ahead} to push, ${status.behind} to pull`}>
                ↑{status.ahead} ↓{status.behind}
              </span>
            )}
            <span className="git-spacer" />
            <button type="button" className="git-btn" data-git="fetch" disabled={!!busy} onClick={() => void act('Fetch', () => work.gitFetch(r))}>Fetch</button>
            <button type="button" className="git-btn" data-git="pull" title="Fast-forward only. If the branches have split, you'll be offered a merge" disabled={!!busy} onClick={() => void act('Pull', () => work.gitPull(r, 'ff-only'))}>Pull</button>
            <button type="button" className="git-btn" data-git="push" title={status?.upstream ? `Push to ${status.upstream}` : 'The first push sets an upstream on origin'} disabled={!!busy} onClick={() => void act('Push', () => work.gitPush(r))}>Push</button>
          </div>
          {busy && <p className="git-busy" role="status">{busy}…</p>}
          {output && (
            <div className={`git-output${output.ok ? '' : ' git-output-bad'}`} role={output.ok ? 'status' : 'alert'} data-git-output={output.ok ? 'ok' : 'error'}>
              <strong>{output.what}{output.ok ? ' done' : ' failed'}</strong>
              {output.text && <pre>{output.text}</pre>}
              {!output.ok && output.what === 'Pull' && /fast-forward|diverg/i.test(output.text) && (
                <button type="button" className="git-btn" data-git="pull-merge" onClick={() => setConfirm({ kind: 'pull-merge' })}>Pull with a merge…</button>
              )}
              <button type="button" className="icon-btn git-output-x" aria-label="Dismiss" onClick={() => setOutput(null)}>×</button>
            </div>
          )}
          {error && <p className="git-output git-output-bad" role="alert">{error}</p>}
          {confirm && (
            <div className="git-confirm" role="alertdialog" aria-label="Confirm" data-git-confirm={confirm.kind}>
              {confirm.kind === 'discard' && <p>{confirm.text}</p>}
              {confirm.kind === 'switch' && <p>{confirm.text}</p>}
              {confirm.kind === 'pull-merge' && <p>Pull and merge the remote branch into yours, making a merge commit if they've split. A conflict stops it partway for you to resolve.</p>}
              <div className="git-confirm-row">
                <button
                  type="button"
                  className="git-btn git-btn-danger"
                  data-git="confirm"
                  onClick={() => {
                    if (confirm.kind === 'discard') void act('Discard', () => work.gitDiscard(r, confirm.entries.map((e) => e.path)), () => setFile(null))
                    else if (confirm.kind === 'switch') void act(`Switch to ${confirm.branch}`, () => work.gitSwitch(r, confirm.branch))
                    else void act('Pull with merge', () => work.gitPull(r, 'merge'))
                  }}
                >
                  {confirm.kind === 'discard' ? 'Discard' : confirm.kind === 'switch' ? 'Switch anyway' : 'Pull and merge'}
                </button>
                <button type="button" className="git-btn" data-git="cancel" onClick={() => setConfirm(null)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="git-tabs" role="tablist">
            {(['changes', 'branches', 'history'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} data-git-tab={t} className={`sidebar-tab${tab === t ? ' sidebar-tab-on' : ''}`} onClick={() => setTab(t)}>
                {t === 'changes' ? `Changes${status ? ` ${status.staged.length + tracked.length + status.conflicts.length}` : ''}` : t === 'branches' ? 'Branches' : 'History'}
              </button>
            ))}
          </div>
          <div className="git-body">
            {tab === 'changes' && status && (
              <>
                <ReviewBar root={r} />
                <div className="git-commit">
                  <textarea aria-label="Commit message" placeholder={`Message for the commit on ${status.branch ?? 'detached HEAD'}`} value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
                  <button type="button" className="git-btn git-btn-main" data-git="commit" disabled={!!busy || !message.trim() || status.staged.length === 0} onClick={() => void act('Commit', () => work.gitCommit(r, message), () => setMessage(''))}>
                    Commit {status.staged.length ? `${status.staged.length} staged` : ''}
                  </button>
                </div>
                {status.conflicts.length > 0 && (
                  <section>
                    <h3 className="git-section">Conflicts <span className="sidebar-count">{status.conflicts.length}</span></h3>
                    <ul>
                      {status.conflicts.map((e) => (
                        <Entry key={e.path} entry={e} selected={file?.path === e.path} onSelect={() => void showDiff(e.path, false)} actions={<button type="button" className="git-mini" title="Mark resolved by staging it" onClick={() => void act('Stage', () => work.gitStage(r, [e.path]))}>Stage</button>} />
                      ))}
                    </ul>
                  </section>
                )}
                <section>
                  <h3 className="git-section">
                    Staged <span className="sidebar-count">{status.staged.length}</span>
                    {status.staged.length > 0 && <button type="button" className="git-mini" data-git="unstage-all" onClick={() => void act('Unstage all', () => work.gitUnstage(r, 'all'))}>Unstage all</button>}
                  </h3>
                  <ul>
                    {status.staged.map((e) => (
                      <Entry key={e.path} entry={e} selected={file?.path === e.path && file.staged} onSelect={() => void showDiff(e.path, true)} actions={<button type="button" className="git-mini" data-git="unstage" title="Unstage" onClick={() => void act('Unstage', () => work.gitUnstage(r, [e.path]))}>−</button>} />
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="git-section">
                    Changes <span className="sidebar-count">{tracked.length}</span>
                    {tracked.length > 0 && (
                      <>
                        <button type="button" className="git-mini" data-git="stage-all" onClick={() => void act('Stage all', () => work.gitStage(r, 'all'))}>Stage all</button>
                        <button type="button" className="git-mini git-mini-danger" data-git="discard-all" onClick={() => setConfirm({ kind: 'discard', entries: tracked, text: discardWarning(tracked) })}>Discard all…</button>
                      </>
                    )}
                  </h3>
                  {status.staged.length + tracked.length + status.conflicts.length === 0 && <p className="git-empty">No changes. The working tree matches {status.branch ?? 'HEAD'}.</p>}
                  <ul>
                    {tracked.map((e) => (
                      <Entry
                        key={`${e.area}:${e.path}`}
                        entry={e}
                        selected={file?.path === e.path && !file.staged}
                        onSelect={() => void showDiff(e.path, false)}
                        actions={
                          <>
                            <button type="button" className="git-mini git-mini-danger" data-git="discard" title={e.area === 'untracked' ? 'Delete this untracked file…' : 'Discard these changes…'} onClick={() => setConfirm({ kind: 'discard', entries: [e], text: discardWarning([e]) })}>↺</button>
                            <button type="button" className="git-mini" data-git="stage" title="Stage" onClick={() => void act('Stage', () => work.gitStage(r, [e.path]))}>+</button>
                          </>
                        }
                      />
                    ))}
                  </ul>
                </section>
                {file && (
                  <section className="git-diff" aria-label={`Changes in ${file.path}`}>
                    <h3 className="git-section">
                      {file.path} {file.staged ? '(staged)' : ''}
                      <button type="button" className="icon-btn" aria-label="Hide the diff" onClick={() => setFile(null)}>×</button>
                    </h3>
                    {diff === null && <p className="git-empty">Loading…</p>}
                    {typeof diff === 'string' && <p className="git-output git-output-bad">{diff}</p>}
                    {diff && typeof diff === 'object' && (diff.binary ? <p className="git-empty">A binary file. No text to show.</p> : (
                      <>
                        <p className="review-hint">Press + beside a line to leave a note for an agent.</p>
                        <ReviewDiff root={r} path={file.path} text={diff.text} />
                        {diff.truncated && <p className="diff-hunk">[Too long to show in full.]</p>}
                      </>
                    ))}
                  </section>
                )}
              </>
            )}
            {tab === 'branches' && (
              <>
                <form
                  className="git-newbranch"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const name = newBranch.trim()
                    if (name) void act(`Create ${name}`, () => work.gitCreateBranch(r, name), () => setNewBranch(''))
                  }}
                >
                  <input aria-label="New branch name" placeholder="New branch from here" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} />
                  <button type="submit" className="git-btn" data-git="create-branch" disabled={!!busy || !newBranch.trim()}>Create and switch</button>
                </form>
                <h3 className="git-section">Local</h3>
                <ul>
                  {branches.filter((b) => !b.remote).map((b) => (
                    <li key={b.name} className={`git-branch${b.current ? ' git-branch-current' : ''}`} data-git-branch-row={b.name}>
                      <span className="git-path">{b.current ? '● ' : ''}{b.name}</span>
                      <span className="git-ab">{b.upstream ? `${b.gone ? 'upstream gone' : `↑${b.ahead} ↓${b.behind}`}` : 'local only'}</span>
                      {!b.current && <button type="button" className="git-mini" data-git="switch" disabled={!!busy} onClick={() => switchTo(b.name)}>Switch</button>}
                    </li>
                  ))}
                </ul>
                {branches.some((b) => b.remote && !followed.has(b.name) && !localNames.has(b.name.split('/').slice(1).join('/'))) && <h3 className="git-section">Remote only</h3>}
                <ul>
                  {branches.filter((b) => b.remote && !followed.has(b.name) && !localNames.has(b.name.split('/').slice(1).join('/'))).map((b) => (
                    <li key={b.name} className="git-branch" data-git-branch-row={b.name}>
                      <span className="git-path">{b.name}</span>
                      <button type="button" className="git-mini" disabled={!!busy} title="Make a local branch that follows it, and switch to it" onClick={() => switchTo(b.name)}>Check out</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {tab === 'history' && (
              <div className="git-history" data-git-history>
                {!log && <p className="git-empty">Loading…</p>}
                {log && log.rows.length === 0 && <p className="git-empty">No commits yet.</p>}
                {log?.rows.map((row) => (
                  <div key={row.hash} className="git-commit-row" data-commit={row.short} data-merge={row.merge || undefined} title={`${row.hash}\n${row.author}, ${new Date(row.time).toLocaleString()}`}>
                    <Graph row={row} lanes={lanes} />
                    <span className="git-commit-text">
                      {row.refs.map((ref) => {
                        const chip = refChip(ref, remotes)
                        return <span key={ref} className={`git-ref git-ref-${chip.kind}`}>{chip.name}</span>
                      })}
                      <span className="git-subject">{row.subject}</span>
                    </span>
                    <span className="git-hash">{row.short}</span>
                  </div>
                ))}
                {log?.truncated && <p className="git-empty">Only the newest commits are shown.</p>}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
