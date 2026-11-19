import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DiffScope, FileDiff, SessionFiles, TouchedFile } from '../shared/filesTouched'
import { bridge } from './bridge'
import { chipLabel, files, listenForFiles, splitPath, useFilesSummary, visibleFiles } from './filesView'
import { relativeTime } from './sidebarView'
import './files.css'

const POPOVER_WIDTH = 460

/** A diff's lines, colored as the git panel colors them. */
function DiffText({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="git-diff-text files-diff-text">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : undefined
        return (
          <span key={i} className={cls}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

function FileRow({ nodeId, data, file, now }: { nodeId: string; data: SessionFiles; file: TouchedFile; now: number }): React.JSX.Element {
  const { name, folder } = splitPath(file.path, data.cwd)
  const others = data.overlaps[file.path]
  const [scope, setScope] = useState<DiffScope | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [problem, setProblem] = useState('')
  const show = (next: DiffScope | null): void => {
    setScope(next)
    setDiff(null)
    if (next && files) void files.diff(nodeId, file.path, next).then(setDiff, (e: unknown) => setDiff({ ok: false, reason: String(e) }))
  }
  return (
    <li className={`files-row${others ? ' files-row-shared' : ''}`} data-file={file.path}>
      <div className="files-row-top">
        <span className="files-name" title={file.path}>
          {name}
          {folder && <span className="files-folder">{folder}</span>}
        </span>
        <span className="files-meta">
          {file.lastTurn !== null ? `turn ${file.lastTurn} · ` : ''}
          {relativeTime(file.lastAt, now)}
        </span>
      </div>
      <div className="files-row-bottom">
        {!file.confirmed && (
          <span className="files-tag files-tag-unconfirmed" title="The transcript never said whether this edit succeeded">
            unconfirmed
          </span>
        )}
        {others && (
          <span className="files-tag files-tag-shared" title="Another live agent edited this file too, in the same checkout">
            ⚠ also {others.map((o) => o.title).join(', ')}
          </span>
        )}
        <span className="files-actions">
          <button
            type="button"
            className="files-btn"
            onClick={() =>
              void bridge.openTerminalLink(nodeId, file.path).then((r) => setProblem(r.ok ? '' : r.reason), (e: unknown) => setProblem(String(e)))
            }
          >
            Open
          </button>
          <button type="button" className={`files-btn${scope === 'turn' ? ' files-btn-on' : ''}`} data-diff="turn" aria-pressed={scope === 'turn'} title="What changed in it since the latest turn started" onClick={() => show(scope === 'turn' ? null : 'turn')}>
            This turn
          </button>
          <button type="button" className={`files-btn${scope === 'session' ? ' files-btn-on' : ''}`} data-diff="session" aria-pressed={scope === 'session'} title="What changed in it since the turn this session first edited it" onClick={() => show(scope === 'session' ? null : 'session')}>
            Session
          </button>
        </span>
      </div>
      {problem && <p className="files-problem">{problem}</p>}
      {scope && !diff && <p className="files-note">Making the diff…</p>}
      {scope && diff && !diff.ok && <p className="files-problem">{diff.reason}</p>}
      {scope && diff?.ok && (
        <>
          <p className="files-note">
            Diff {diff.base}.{diff.truncated ? ' Cut short: it is long.' : ''} Other agents' changes to it in that time show too.
          </p>
          {diff.text.trim() ? <DiffText text={diff.text} /> : <p className="files-note">No change in that time.</p>}
        </>
      )}
    </li>
  )
}

function FilesPopover({ nodeId, at, onClose }: { nodeId: string; at: { x: number; y: number }; onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<SessionFiles | null | undefined>(undefined)
  const [onlyTurn, setOnlyTurn] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  const count = useFilesSummary((s) => s.summary[nodeId]?.count ?? 0)
  const now = Date.now()

  useEffect(() => {
    if (!files) return
    let live = true
    void files.get(nodeId).then((d) => live && setData(d), () => live && setData(null))
    return () => {
      live = false
    }
    // Read again when the count moves, so a working agent's list keeps up.
  }, [nodeId, count])

  useEffect(() => {
    const away = (e: MouseEvent): void => {
      // The chip toggles it itself.
      if ((e.target as Element).closest?.(`[data-files-chip="${CSS.escape(nodeId)}"]`)) return
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('keydown', key)
    }
  }, [onClose, nodeId])

  // Kept on screen: moved left or up when it would run off the window.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))
    const y = at.y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - r.height - 8) : at.y
    if (x !== pos.x || y !== pos.y) setPos({ x, y })
  }, [at, data, pos])

  const shown = useMemo(() => (data ? visibleFiles(data, onlyTurn) : []), [data, onlyTurn])
  const latest = data?.turns.at(-1)
  return (
    <div ref={box} className="files-popover nodrag nowheel" role="dialog" aria-label="Files this session edited" style={{ left: pos.x, top: pos.y, width: POPOVER_WIDTH }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="files-head">
        <strong>Files edited</strong>
        <span className="files-scope" role="tablist" aria-label="Which edits">
          <button type="button" role="tab" aria-selected={!onlyTurn} className={`files-btn${!onlyTurn ? ' files-btn-on' : ''}`} onClick={() => setOnlyTurn(false)}>
            Session
          </button>
          <button type="button" role="tab" aria-selected={onlyTurn} data-files-turn className={`files-btn${onlyTurn ? ' files-btn-on' : ''}`} onClick={() => setOnlyTurn(true)}>
            This turn
          </button>
        </span>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {latest && (
        <p className="files-note">
          Turn {latest.turn} started {relativeTime(latest.at, now)}.{' '}
          {latest.tree ? 'A snapshot was taken then, so its diff shows only what changed since.' : latest.problem ? `No snapshot: ${latest.problem}` : 'Taking a snapshot…'}
        </p>
      )}
      {data === undefined && <p className="files-note">Reading…</p>}
      {data === null && <p className="files-note">No edits recorded for this session.</p>}
      {data && shown.length === 0 && <p className="files-note">{onlyTurn ? 'Nothing edited in this turn yet.' : 'No edits recorded for this session.'}</p>}
      {data && shown.length > 0 && (
        <ul className="files-list">
          {shown.map((f) => (
            <FileRow key={f.path} nodeId={nodeId} data={data} file={f} now={now} />
          ))}
        </ul>
      )}
      {data?.truncated && <p className="files-note">Older files were dropped from this list.</p>}
      <p className="files-note files-foot">From the agent's own edit and patch calls. Files changed by shell commands aren't listed.</p>
    </div>
  )
}

/** "N files" on an agent's header or sidebar row, amber when another live agent edited one of them too. */
export function FilesChip({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  useEffect(listenForFiles, [])
  const badge = useFilesSummary((s) => s.summary[nodeId])
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  if (!badge || badge.count === 0) return null
  const label = chipLabel(badge.count, badge.overlap)
  const toggle = (e: React.SyntheticEvent<HTMLElement>): void => {
    e.stopPropagation()
    if (at) return setAt(null)
    const r = e.currentTarget.getBoundingClientRect()
    setAt({ x: r.left, y: r.bottom + 4 })
  }
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className={`files-chip nodrag${badge.overlap ? ' files-chip-shared' : ''}`}
        data-files-chip={nodeId}
        title={label.title}
        aria-haspopup="dialog"
        aria-expanded={!!at}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle(e)
          }
        }}
      >
        {badge.overlap ? '⚠ ' : ''}
        {label.text}
      </span>
      {/* Drawn outside the node, because a zoomed canvas would scale and clip it. */}
      {at && createPortal(<FilesPopover nodeId={nodeId} at={at} onClose={() => setAt(null)} />, document.body)}
    </>
  )
}
