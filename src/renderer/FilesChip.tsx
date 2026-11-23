import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DiffScope, FileDiff, SessionFiles, TouchedFile } from '../shared/filesTouched'
import { bridge } from './bridge'
import { Icon } from './icons'
import { chipLabel, endCheckNote, files, listenForFiles, originTags, splitPath, useFilesSummary, visibleFiles } from './filesView'
import { relativeTime } from './sidebarView'
import { measureSafeArea } from './safeArea'
import { popoverPlace, type PopoverPlace } from './popoverPlace'
import './files.css'

const POPOVER_WIDTH = 460
const MAX_HEIGHT = 640

/** How the list is made, behind the popover's (i). */
const FOOT =
  "From the agent's own edit and patch calls and its subagents' (labelled). At the end of each turn, files that changed with no such edit are listed as changed by a command or another process, never as the agent's edits; not when another agent shares the checkout."

/** The top of the dock and minimap, in window pixels: where a popover stops. Null before the canvas is drawn. */
function chromeFloor(): number | null {
  const canvas = document.querySelector('.react-flow')?.getBoundingClientRect()
  const safe = measureSafeArea()
  return canvas && safe ? canvas.top + safe.y + safe.height : null
}

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

/** What "unconfirmed" means, on the tag and in the popover's (i). */
const UNCONFIRMED = "Unconfirmed: the agent made this edit, but its conversation never said whether it worked. The file may not have changed."

/** One file. Its diff is over the span the header chose: this turn, or the session. */
function FileRow({ nodeId, data, file, now, scope }: { nodeId: string; data: SessionFiles; file: TouchedFile; now: number; scope: DiffScope }): React.JSX.Element {
  const { name, folder } = splitPath(file.path, data.cwd)
  const others = data.overlaps[file.path]
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [problem, setProblem] = useState('')
  // Made again when the header's span changes while it's shown.
  useEffect(() => {
    setDiff(null)
    if (!open || !files) return
    let live = true
    void files.diff(nodeId, file.path, scope).then(
      (d) => live && setDiff(d),
      (e: unknown) => live && setDiff({ ok: false, reason: String(e) })
    )
    return () => {
      live = false
    }
  }, [open, scope, nodeId, file.path])
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
          <span className="files-tag files-tag-unconfirmed" title={UNCONFIRMED}>
            unconfirmed
          </span>
        )}
        {originTags(file).map((t) => (
          <span key={t.kind} className={`files-tag files-tag-${t.kind}`} data-origin={t.kind} title={t.title}>
            {t.text}
          </span>
        ))}
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
          <button
            type="button"
            className={`files-btn${open ? ' files-btn-on' : ''}`}
            data-diff={scope}
            aria-pressed={open}
            title={scope === 'turn' ? 'What changed in it since the latest turn started' : 'What changed in it since the turn this session first edited it'}
            onClick={() => setOpen(!open)}
          >
            Diff
          </button>
        </span>
      </div>
      {problem && <p className="files-problem">{problem}</p>}
      {open && !diff && <p className="files-note">Making the diff…</p>}
      {open && diff && !diff.ok && <p className="files-problem">{diff.reason}</p>}
      {open && diff?.ok && (
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
  const [about, setAbout] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<PopoverPlace>({ ...at, maxHeight: window.innerHeight - at.y - 8 })
  const count = useFilesSummary((s) => (s.summary[nodeId]?.count ?? 0) + (s.summary[nodeId]?.changed ?? 0))
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

  // Kept on screen and clear of the dock and minimap: moved left, or up, or made to scroll.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const p = popoverPlace(at, { width: el.offsetWidth, height: el.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, chromeFloor())
    if (p.x !== pos.x || p.y !== pos.y || p.maxHeight !== pos.maxHeight) setPos(p)
  }, [at, data, pos, about])

  const shown = useMemo(() => (data ? visibleFiles(data, onlyTurn) : []), [data, onlyTurn])
  const latest = data?.turns.at(-1)
  const scope: DiffScope = onlyTurn ? 'turn' : 'session'
  return (
    <div
      ref={box}
      className="files-popover nodrag nowheel"
      role="dialog"
      aria-label="Files this session edited"
      style={{ left: pos.x, top: pos.y, width: POPOVER_WIDTH, maxHeight: Math.min(pos.maxHeight, MAX_HEIGHT) }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="files-head">
        <strong>Files edited</strong>
        <span className="files-scope" role="tablist" aria-label="Which edits, and what each diff covers">
          <button type="button" role="tab" aria-selected={!onlyTurn} className={`files-btn${!onlyTurn ? ' files-btn-on' : ''}`} title="Every file this session edited. A diff covers the whole session." onClick={() => setOnlyTurn(false)}>
            Session
          </button>
          <button type="button" role="tab" aria-selected={onlyTurn} data-files-turn className={`files-btn${onlyTurn ? ' files-btn-on' : ''}`} title="Files edited in the latest turn. A diff covers only that turn." onClick={() => setOnlyTurn(true)}>
            This turn
          </button>
        </span>
        <button type="button" className={`icon-btn files-about-btn${about ? ' files-about-on' : ''}`} data-files-about aria-expanded={about} aria-label="How this list is made" title="How this list is made" onClick={() => setAbout(!about)}>
          <span aria-hidden="true">i</span>
        </button>
        <button type="button" className="icon-btn shell-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {about && (
        <div className="files-about">
          {latest && (
            <p className="files-note">
              Turn {latest.turn} started {relativeTime(latest.at, now)}.{' '}
              {latest.tree ? 'A snapshot was taken then, so its diff shows only what changed since.' : latest.problem ? `No snapshot: ${latest.problem}` : 'Taking a snapshot…'}
              {endCheckNote(latest) && <> {endCheckNote(latest)}</>}
            </p>
          )}
          <p className="files-note">{FOOT}</p>
          <p className="files-note">{UNCONFIRMED}</p>
        </div>
      )}
      {/* What can't wait for the (i): this turn's diffs can't be made. */}
      {!about && latest && !latest.tree && latest.problem && <p className="files-problem">No snapshot for turn {latest.turn}, so its diffs can't be made: {latest.problem}</p>}
      {data === undefined && <p className="files-note">Reading…</p>}
      {data === null && <p className="files-note">No edits recorded for this session.</p>}
      {data && shown.length === 0 && <p className="files-note">{onlyTurn ? 'Nothing edited in this turn yet.' : 'No edits recorded for this session.'}</p>}
      {data && shown.length > 0 && (
        <ul className="files-list">
          {shown.map((f) => (
            <FileRow key={f.path} nodeId={nodeId} data={data} file={f} now={now} scope={scope} />
          ))}
        </ul>
      )}
      {data?.truncated && <p className="files-note">Older files were dropped from this list.</p>}
    </div>
  )
}

/** "N files" on an agent's header or sidebar row, amber when another live agent edited one of them too. */
export function FilesChip({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  useEffect(listenForFiles, [])
  const badge = useFilesSummary((s) => s.summary[nodeId])
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  if (!badge || badge.count + (badge.changed ?? 0) === 0) return null
  const label = chipLabel(badge.count, badge.overlap, badge.changed ?? 0)
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
