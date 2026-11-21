import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { attemptLabel, changedByRun, describeLoss, verifyStanding, type Attempt, type AttemptKey, type AttemptState, type Comparison, type FileChange, type RemovalCheck } from '../shared/compare'
import { AGENT_NAMES } from '../shared/model'
import { StatusBadge, StatusDot } from './nodes/StatusBadge'
import { StatusPair } from './status/StatusMarks'
import { compare } from './compareBridge'
import { parseDiff } from './reviewNotes'
import { shortPath } from './shortPath'
import { useStore } from './store'
import { Panel } from './shell/Panel'
import { confirmThen } from './shell/confirmStore'

const REFRESH_MS = 5000


const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '—')
const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const shown = (argv: string[]): string => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')

function totals(files: FileChange[]): string {
  const add = files.reduce((n, f) => n + (f.added ?? 0), 0)
  const del = files.reduce((n, f) => n + (f.removed ?? 0), 0)
  return `${files.length} file${files.length === 1 ? '' : 's'}, +${add} −${del}`
}

function DiffText({ text }: { text: string }): React.JSX.Element {
  const lines = useMemo(() => parseDiff(text), [text])
  return (
    <pre className="git-diff-text compare-diff">
      {lines.map((l, i) => (
        <span key={i} className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : l.kind === 'hunk' ? 'diff-hunk' : undefined}>
          {l.text}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}

function FileList({ c, a, files, side, label, open, setOpen }: { c: Comparison; a: Attempt; files: FileChange[]; side: 'committed' | 'uncommitted'; label: string; open: string | null; setOpen: (k: string | null) => void }): React.JSX.Element {
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | { reason: string } | null>(null)
  const openHere = open?.startsWith(`${side}:`) ? open.slice(side.length + 1) : null
  useEffect(() => {
    setDiff(null)
    if (openHere) void compare.diff(c.id, a.key, openHere, side).then((r) => setDiff(r.ok ? { text: r.text, truncated: r.truncated } : { reason: r.reason }))
  }, [c.id, a.key, openHere, side])
  return (
    <div className={`compare-changes compare-changes-${side}`} data-side={side}>
      <div className="compare-changes-head">
        <span className={`compare-side compare-side-${side}`}>{label}</span>
        <span className="compare-dim">{files.length ? totals(files) : 'none'}</span>
      </div>
      {files.length > 0 && (
        <ul className="compare-filelist">
          {files.map((f) => (
            <li key={f.path}>
              <button type="button" className={`compare-file${openHere === f.path ? ' compare-file-on' : ''}`} onClick={() => setOpen(openHere === f.path ? null : `${side}:${f.path}`)}>
                <code>{f.path}</code>
                {f.untracked ? <span className="compare-new">new, untracked</span> : f.added === null ? <span className="compare-dim">binary</span> : (
                  <span className="compare-counts">
                    <span className="diff-add">+{f.added}</span> <span className="diff-del">−{f.removed}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {openHere && (diff === null ? <p className="compare-dim">Reading the diff…</p> : 'reason' in diff ? <p className="field-problem">{diff.reason}</p> : (
        <>
          <DiffText text={diff.text} />
          {diff.truncated && <p className="compare-dim">The diff is too long to show in full.</p>}
        </>
      ))}
    </div>
  )
}

function Verification({ c, a, state, running, onRun }: { c: Comparison; a: Attempt; state: AttemptState | null; running: boolean; onRun: () => void }): React.JSX.Element {
  const standing = verifyStanding(a, state)
  return (
    <section className="compare-verify" aria-label={`Verification of attempt ${attemptLabel(a.key)}`}>
      <div className="compare-changes-head">
        <span className="compare-section">Verification</span>
        {c.verify && !a.removed && (
          <button type="button" className="btn btn-sm" disabled={running} onClick={onRun}>
            {running ? 'Running…' : standing.kind === 'not-run' ? 'Run' : 'Run again'}
          </button>
        )}
      </div>
      {!c.verify && <p className="compare-dim">No verification command was given for this comparison.</p>}
      {c.verify && standing.kind === 'not-run' && <p className="compare-verify-none">Not run</p>}
      {c.verify && standing.kind === 'unavailable' && <p className="compare-verify-none">Unavailable: {standing.why}</p>}
      {(standing.kind === 'current' || standing.kind === 'older') && (() => {
        const r = standing.result
        const passed = r.exitCode === 0
        const outcome = r.missing ? "couldn't start" : r.timedOut ? 'timed out' : `exit ${r.exitCode ?? '?'}`
        return (
          <>
            <div className="compare-verify-line">
              <span className={`compare-exit ${passed ? 'compare-exit-pass' : 'compare-exit-fail'}`}>{outcome}</span>
              <code className="compare-cmd">{shown(r.argv)}</code>
            </div>
            <p className="compare-dim">
              {seconds(r.durationMs)} · {when(r.startedAt)} · at {short(r.head)}
              {standing.kind === 'older' && <span className="compare-older"> · Ran on an older state: the attempt has changed since</span>}
            </p>
            {changedByRun(r) && <p className="compare-warn compare-note">The check itself changed the worktree (it wrote or committed files). The result is judged against what it left.</p>}
            <details className="compare-output" open={!passed}>
              <summary>Output{r.truncated ? ` (the last ${kb(r.output.length)}${r.totalBytes ? ` of ${kb(r.totalBytes)}` : ''})` : ''}</summary>
              <pre>{r.output.trim() || '(no output)'}</pre>
            </details>
          </>
        )
      })()}
    </section>
  )
}

function Removal({ c, a, onDone }: { c: Comparison; a: Attempt; onDone: () => void }): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [needs, setNeeds] = useState<RemovalCheck | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const go = async (confirm?: RemovalCheck): Promise<void> => {
    setBusy(true)
    setProblem(null)
    const r = await compare.remove(c.id, a.key, { deleteBranch, confirm })
    setBusy(false)
    if (r.ok) {
      setAsking(false)
      setNeeds(null)
      onDone()
      return
    }
    setNeeds(r.needs ?? null)
    // Refused after a confirmation: what would be lost has changed since it was shown.
    if (!r.needs || confirm) setProblem(confirm && r.needs ? 'This changed since you looked. Here is what removing it would lose now.' : r.reason)
    onDone()
  }

  if (a.removed) return <p className="compare-dim">Worktree removed {when(a.removed.at)}. {a.removed.branchDeleted ? `Branch ${a.branch} deleted.` : `Branch ${a.branch} kept.`}</p>
  if (!asking) {
    return (
      <button type="button" className="btn btn-sm btn-risky" data-remove={a.key} onClick={() => setAsking(true)}>
        Remove worktree…
      </button>
    )
  }
  return (
    <Panel
      kind="modal"
      title={`Remove attempt ${attemptLabel(a.key)}'s worktree?`}
      icon="trash"
      className="shell-confirm shell-confirm-danger compare-remove"
      layerClassName="shell-layer-confirm"
      onClose={() => (setAsking(false), setNeeds(null))}
      busy={busy}
      attrs={{ role: 'alertdialog' }}
      footer={
        <>
          <button type="button" className="btn" data-autofocus onClick={() => (setAsking(false), setNeeds(null))}>
            Keep
          </button>
          {needs ? (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void go(needs)}>
              Remove and lose them
            </button>
          ) : (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void go()}>
              Remove worktree
            </button>
          )}
        </>
      }
    >
      <p className="confirm-message">Deletes the folder {a.path}, including git-ignored files. Sessions in it stop.</p>
      <label className="compare-check">
        <input type="checkbox" checked={deleteBranch} onChange={(e) => (setDeleteBranch(e.target.checked), setNeeds(null))} />
        <span>Also delete branch {a.branch}</span>
      </label>
      {needs && (
        <div className="compare-loss" role="alert">
          <p>This would lose {describeLoss(needs, a.branch)}.</p>
          {!!needs.files?.length && (
            <p className="compare-loss-list">
              Uncommitted: {needs.files.join(', ')}
              {needs.uncommitted > needs.files.length ? ` and ${needs.uncommitted - needs.files.length} more` : ''}
            </p>
          )}
          {!!needs.ignoredFiles?.length && (
            <p className="compare-loss-list">
              Ignored: {needs.ignoredFiles.join(', ')}
              {needs.ignored > needs.ignoredFiles.length ? ` and ${needs.ignored - needs.ignoredFiles.length} more` : ''}
            </p>
          )}
        </div>
      )}
      {problem && <p className="field-problem">{problem}</p>}
    </Panel>
  )
}

function AttemptColumn({ c, a, state, running, onRun, onChanged, onShow }: { c: Comparison; a: Attempt; state: AttemptState | null; running: boolean; onRun: () => void; onChanged: (c?: Comparison) => void; onShow: (id: string) => void }): React.JSX.Element {
  const node = useStore((s) => s.doc?.nodes.find((n) => n.id === a.nodeId))
  const status = useStore((s) => s.statuses[a.nodeId])
  const [open, setOpen] = useState<string | null>(null)
  const chosen = c.chosen?.key === a.key
  const agentState = !node ? 'closed' : status ?? 'unknown'

  return (
    <article className={`compare-attempt${chosen ? ' compare-attempt-chosen' : ''}`} data-attempt={a.key}>
      <header className="compare-attempt-head">
        <span className="compare-badge">{attemptLabel(a.key)}</span>
        <span className="compare-agent-name">{AGENT_NAMES[a.agent]}</span>
        {agentState === 'closed' ? (
          <StatusPair look={{ tone: 'ended', label: 'Closed' }} className="compare-status" />
        ) : (
          <span className="st-pair compare-status">
            <StatusDot status={agentState} nodeId={a.nodeId} />
            <StatusBadge status={agentState} nodeId={a.nodeId} />
          </span>
        )}
        {node && (
          <button type="button" className="btn btn-sm" onClick={() => onShow(a.nodeId)}>
            Show
          </button>
        )}
      </header>
      {a.approach && <p className="compare-approach">Approach: {a.approach}</p>}
      <dl className="compare-facts">
        <dt>Baseline</dt>
        <dd>
          <code title={c.base.commit}>{short(c.base.commit)}</code>
        </dd>
        <dt>Branch</dt>
        <dd>
          <code>{a.branch}</code>
          {state?.ok && state.branch !== a.branch && <span className="compare-warn"> now on {state.branch ?? 'a detached HEAD'}</span>}
        </dd>
        <dt>Folder</dt>
        <dd>
          <code className="compare-path" title={a.path}>
            {shortPath(a.path)}
          </code>
        </dd>
        <dt>Now at</dt>
        <dd>
          {state?.ok ? (
            <>
              <code title={state.head ?? ''}>{short(state.head)}</code>, {state.commits.length} commit{state.commits.length === 1 ? '' : 's'} since the baseline
              {!state.fromBase && <span className="compare-warn"> · no longer contains the baseline</span>}
            </>
          ) : (
            <span className="compare-dim">{a.removed ? 'removed' : state ? state.reason : 'reading…'}</span>
          )}
        </dd>
      </dl>

      {state?.ok && state.commits.length > 0 && (
        <ul className="compare-commits">
          {state.commits.slice(0, 5).map((cm) => (
            <li key={cm.hash}>
              <code>{short(cm.hash)}</code> {cm.subject}
            </li>
          ))}
          {state.commits.length > 5 && <li className="compare-dim">and {state.commits.length - 5} more</li>}
        </ul>
      )}

      {state?.ok && (
        <>
          <FileList c={c} a={a} files={state.committed} side="committed" label="Committed since baseline" open={open} setOpen={setOpen} />
          <FileList c={c} a={a} files={state.uncommitted} side="uncommitted" label="Uncommitted in the worktree" open={open} setOpen={setOpen} />
        </>
      )}

      <Verification c={c} a={a} state={state} running={running} onRun={onRun} />

      <footer className="compare-attempt-foot">
        {chosen ? (
          <span className="compare-chosen-mark">Chosen</span>
        ) : (
          <button type="button" className="btn btn-sm" data-choose={a.key} onClick={() => void compare.choose(c.id, a.key).then((r) => onChanged(r.ok ? r.comparison : undefined))}>
            Choose {attemptLabel(a.key)}
          </button>
        )}
        <Removal c={c} a={a} onDone={() => onChanged()} />
      </footer>
    </article>
  )
}

/**
 * Comparisons in this project, and the chosen one side by side. Looking only reads git; nothing here merges, commits
 * or switches. Choosing records the choice. Removal asks again for anything that would lose work.
 */
export function CompareView({ projectId, initial, notice, onShow, onClose }: { projectId: string; initial: string | null; notice?: string; onShow: (nodeId: string) => void; onClose: () => void }): React.JSX.Element {
  const [list, setList] = useState<Comparison[] | null>(null)
  const [id, setId] = useState<string | null>(initial)
  const [states, setStates] = useState<Partial<Record<AttemptKey, AttemptState>>>({})
  const [running, setRunning] = useState<Partial<Record<AttemptKey, boolean>>>({})
  const [problem, setProblem] = useState<string | null>(notice ?? null)

  const loadList = useCallback(async (): Promise<void> => {
    const l = await compare.list(projectId)
    setList(l)
    setId((cur) => (cur && l.some((c) => c.id === cur) ? cur : l[0]?.id ?? null))
  }, [projectId])
  useEffect(() => void loadList(), [loadList])

  const c = list?.find((x) => x.id === id) ?? null
  const current = useRef(c)
  current.current = c
  // Which attempts there are to read: a removal changes it, a new verification result doesn't.
  const shape = c ? `${c.id}:${c.attempts.map((a) => `${a.key}${a.removed ? '-' : ''}`).join(',')}` : ''
  const readStates = useCallback(async (): Promise<void> => {
    const now = current.current
    if (!now) return
    const pairs = await Promise.all(now.attempts.map(async (a) => [a.key, await compare.state(now.id, a.key)] as const))
    if (current.current?.id === now.id) setStates(Object.fromEntries(pairs))
  }, [])
  const shownId = useRef(id)
  useEffect(() => {
    if (shownId.current === id) return
    shownId.current = id
    setStates({})
    setProblem(null)
  }, [id])
  // The record and git are both read again while the view is open, so what it shows doesn't go stale.
  useEffect(() => {
    void readStates()
    const t = setInterval(() => {
      // Nothing to see while the window is hidden, so git isn't asked.
      if (document.hidden) return
      void loadList()
      void readStates()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [readStates, loadList, shape])

  const replace = (next?: Comparison): void => {
    if (next) setList((l) => l?.map((x) => (x.id === next.id ? next : x)) ?? null)
    else void loadList()
    void readStates()
  }

  const run = async (keys: AttemptKey[]): Promise<void> => {
    if (!c) return
    setProblem(null)
    // One at a time, so two test runs never fight over a port or a database.
    for (const key of keys) {
      setRunning((r) => ({ ...r, [key]: true }))
      const r = await compare.verify(c.id, key)
      setRunning((s) => ({ ...s, [key]: false }))
      if (r.ok) replace(r.comparison)
      else setProblem(`Attempt ${attemptLabel(key)}: ${r.reason}`)
    }
  }

  const chosenAttempt = c?.chosen ? c.attempts.find((a) => a.key === c.chosen!.key) : undefined
  const anyRunning = Object.values(running).some(Boolean)

  return (
    <Panel
      kind="view"
      title={c ? c.title : 'Comparisons'}
      icon="branch"
      label="Comparisons"
      className="compare-sheet"
      onClose={onClose}
      initialFocus="panel"
      flush
      actions={
        c && (
          <button
            type="button"
            className="btn btn-sm btn-risky"
            data-compare="forget"
            onClick={() =>
              void confirmThen(
                { title: 'Forget this comparison?', message: 'Its worktrees, branches and agents stay as they are. Only this record goes.', verb: 'Forget comparison', attrs: { 'data-compare-confirm': 'forget' } },
                () => compare.forget(c.id).then(() => loadList())
              )
            }
          >
            Forget comparison…
          </button>
        )
      }
    >
      <div className="compare-body">
      <nav className="compare-list" aria-label="Comparisons in this project">
        <span className="field-label">Comparisons</span>
        {list && !list.length && <p className="compare-dim">None yet. Use Try another approach to start one.</p>}
        {list?.map((x) => (
          <button type="button" key={x.id} className={`compare-item${x.id === id ? ' compare-item-on' : ''}`} onClick={() => setId(x.id)}>
            <span className="compare-item-title">{x.title}</span>
            {x.projectId !== projectId && <span className="compare-warn compare-note">From a deleted project</span>}
            <span className="compare-dim">
              {when(x.createdAt)}
              {x.chosen ? ` · chose ${attemptLabel(x.chosen.key)}` : ''}
            </span>
          </button>
        ))}
      </nav>

      <div className="compare-main">
        {c && (
          <>
            <div className="compare-summary">
              <p>
                Both from <code title={c.base.commit}>{short(c.base.commit)}</code>
                {c.base.branch ? ` on ${c.base.branch}` : ''} in <code>{c.base.source}</code>, {when(c.createdAt)}.
                {c.base.uncommitted === 'left-out' && <span className="compare-warn"> Uncommitted changes in that checkout were left out, as chosen.</span>}
              </p>
              <details className="compare-brief">
                <summary>Brief</summary>
                <pre>{c.brief}</pre>
              </details>
              <div className="compare-verify-all">
                {c.verify ? (
                  <>
                    <span className="field-label">Verification</span>
                    <code className="compare-cmd">{shown(c.verify)}</code>
                    <button type="button" className="btn btn-sm" disabled={anyRunning} onClick={() => void run(c.attempts.filter((a) => !a.removed).map((a) => a.key))}>
                      {anyRunning ? 'Running…' : 'Run in both'}
                    </button>
                  </>
                ) : (
                  <span className="compare-dim">No verification command for this comparison.</span>
                )}
              </div>
              {c.chosen && chosenAttempt && (
                <div className="compare-chosen" role="status">
                  <span>
                    Chosen: attempt {attemptLabel(c.chosen.key)} ({chosenAttempt.branch}, at {short(c.chosen.head)}), {when(c.chosen.at)}. Nothing has been merged. To use it, merge{' '}
                    <code>{chosenAttempt.branch}</code> yourself with Git.
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => void compare.choose(c.id, null).then((r) => replace(r.ok ? r.comparison : undefined))}>
                    Clear choice
                  </button>
                </div>
              )}
              {problem && <p className="field-problem">{problem}</p>}
            </div>

            <div className="compare-columns">
              {c.attempts.map((a) => (
                <AttemptColumn key={a.key} c={c} a={a} state={states[a.key] ?? null} running={!!running[a.key]} onRun={() => void run([a.key])} onChanged={replace} onShow={onShow} />
              ))}
              {c.attempts.length < 2 && !c.unreadable?.length && <p className="compare-dim">Attempt B was not made.</p>}
              {!!c.unreadable?.length && <p className="compare-warn">{c.unreadable.length} attempt record{c.unreadable.length === 1 ? '' : 's'} couldn't be read by this version. {c.unreadable.length === 1 ? 'It is' : 'They are'} kept as written.</p>}
            </div>

          </>
        )}
      </div>
      </div>
    </Panel>
  )
}
