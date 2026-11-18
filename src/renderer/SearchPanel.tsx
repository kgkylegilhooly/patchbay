import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { IndexStats, SearchHit, SearchKind } from '../core/search/types'
import { bridge } from './bridge'
import { ClaudeIcon, CodexIcon, Icon } from './icons'
import { closeSearch, markedParts, openHandoff, RANGES, rangeStart, searchBridge, useSearchUi, type DateRange } from './searchUi'
import { useStore } from './store'
import './search.css'

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const KINDS: Array<{ id: SearchKind | 'all'; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'conversation', label: 'Conversations' },
  { id: 'note', label: 'Notes' },
  { id: 'message', label: 'Messages' }
]
const TYPING_MS = 180

/** What the drawer remembers between openings, so going to a result and back keeps the search. */
const kept = { text: '', projectId: '', range: 'any' as DateRange, kind: 'all' as SearchKind | 'all' }

function KindMark({ hit }: { hit: SearchHit }): React.JSX.Element {
  if (hit.kind === 'conversation') return hit.agent === 'codex' ? <CodexIcon /> : <ClaudeIcon />
  return <Icon name={hit.kind === 'note' ? 'note' : hit.kind === 'message' ? 'link' : 'check'} size={14} />
}

function statsLine(s: IndexStats): string {
  const parts = [`${s.conversations} conversation${s.conversations === 1 ? '' : 's'}`, `${s.notes} note${s.notes === 1 ? '' : 's'}`, `${s.messages} message${s.messages === 1 ? '' : 's'}`]
  if (s.other) parts.push(`${s.other} other`)
  return `Indexed ${parts.join(', ')}${s.syncedAt ? `, updated ${TIME.format(s.syncedAt)}` : ''}.`
}

interface Viewing {
  title: string
  hit: SearchHit
  text: string | null
  problem: string | null
}

/** The transcript or text a result came from, scrolled to the first match. */
function SourceViewer({ viewing, terms, onClose }: { viewing: Viewing; terms: string[]; onClose: () => void }): React.JSX.Element {
  const mark = useRef<HTMLElement>(null)
  const text = viewing.text
  const at = useMemo(() => {
    if (!text) return -1
    const low = text.toLowerCase()
    const hits = terms.map((t) => low.indexOf(t)).filter((i) => i !== -1)
    return hits.length ? Math.min(...hits) : -1
  }, [text, terms])
  const length = at === -1 ? 0 : (terms.find((t) => text!.toLowerCase().startsWith(t, at))?.length ?? 0)
  useEffect(() => mark.current?.scrollIntoView({ block: 'center' }), [at])
  const closedId = viewing.hit.ref.type === 'closed' ? viewing.hit.ref.closedId : null
  return (
    <div className="viewer search-viewer" role="dialog" aria-label={`Source of ${viewing.title}`}>
      <header className="drawer-head">
        <h2>{viewing.title}</h2>
        <div className="search-viewer-actions">
          {closedId && (
            <>
              <button className="btn" onClick={() => void bridge.reopenClosed(closedId).then(onClose)}>
                Reopen
              </button>
              <button className="btn" onClick={() => openHandoff({ type: 'closed', closedId }, viewing.title)}>
                Continue with another agent…
              </button>
            </>
          )}
          <button className="icon-btn" aria-label="Close source" onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      {viewing.problem ? (
        <p className="drawer-empty">{viewing.problem}</p>
      ) : (
        <pre className="viewer-text" tabIndex={0}>
          {text === null ? (
            'Loading…'
          ) : at === -1 ? (
            text
          ) : (
            <>
              {text.slice(0, at)}
              <mark ref={mark}>{text.slice(at, at + length)}</mark>
              {text.slice(at + length)}
            </>
          )}
        </pre>
      )}
    </div>
  )
}

/** Search across every project's conversations, closed ones included, notes and agents' messages. */
export function SearchPanel(): React.JSX.Element {
  const flow = useReactFlow()
  const projects = useStore((s) => s.doc?.projects)
  const [text, setText] = useState(kept.text)
  const [projectId, setProjectId] = useState(kept.projectId)
  const [range, setRange] = useState<DateRange>(kept.range)
  const [kind, setKind] = useState<SearchKind | 'all'>(kept.kind)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [more, setMore] = useState(false)
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const asked = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  Object.assign(kept, { text, projectId, range, kind })

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    void searchBridge()
      .stats()
      .then((r) => (r.ok ? setStats(r.stats) : setProblem(r.reason)))
  }, [])

  useEffect(() => {
    const n = ++asked.current
    if (!text.trim()) {
      setHits([])
      setMore(false)
      setBusy(false)
      return
    }
    setBusy(true)
    const timer = setTimeout(() => {
      const from = rangeStart(range, Date.now())
      void searchBridge()
        .search({ text, ...(projectId ? { projectId } : {}), ...(from !== undefined ? { from } : {}), ...(kind !== 'all' ? { kinds: [kind] } : {}) })
        .then((r) => {
          if (n !== asked.current) return
          setBusy(false)
          if (!r.ok) return setProblem(r.reason)
          setProblem(null)
          setHits(r.result.hits)
          setMore(r.result.more)
          setStats(r.result.stats)
        })
    }, TYPING_MS)
    return () => clearTimeout(timer)
  }, [text, projectId, range, kind])

  // Projects the index knows by name, deleted ones included, so their conversations can still be picked out.
  const projectChoices = useMemo(() => {
    const live = (projects ?? []).map((p) => ({ id: p.id, name: p.name }))
    const gone = new Map<string, string>()
    for (const h of hits) if (h.projectGone && h.projectId && h.projectName) gone.set(h.projectId, `${h.projectName} (deleted)`)
    if (projectId && !live.some((p) => p.id === projectId) && !gone.has(projectId)) gone.set(projectId, 'Deleted project')
    return [...live, ...[...gone].map(([id, name]) => ({ id, name }))]
  }, [projects, hits, projectId])

  const terms = useMemo(() => [...text.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).trim().replace(/\s+/g, ' ')).filter(Boolean), [text])

  /** Puts a node on screen, switching to its project first. False if it's no longer on the canvas. */
  const showNode = (id: string): boolean => {
    const doc = useStore.getState().doc
    const node = doc?.nodes.find((n) => n.id === id)
    if (!doc || !node) return false
    const switching = !!node.projectId && node.projectId !== doc.activeProjectId
    if (switching) void bridge.dispatch({ op: 'switchProject', id: node.projectId! })
    const center = (): void => void flow.fitView({ nodes: [{ id }], padding: 0.2, maxZoom: 1, duration: 260 })
    // A node in another project only exists on screen once its project has been drawn.
    if (!switching && flow.getNode(id)) center()
    else setTimeout(center, 300)
    closeSearch()
    return true
  }

  const open = (hit: SearchHit): void => {
    const ref = hit.ref
    if (ref.type === 'node' && showNode(ref.nodeId)) return
    if (ref.type === 'message' && (showNode(ref.to) || showNode(ref.from))) return
    if (ref.type === 'closed') {
      setViewing({ title: hit.title, hit, text: null, problem: null })
      void bridge.readClosedTranscript(ref.closedId).then((r) => setViewing((v) => (v?.hit === hit ? { ...v, text: r.ok ? r.text : null, problem: r.ok ? null : r.reason } : v)))
      return
    }
    setViewing({ title: hit.title, hit, text: hit.snippet, problem: ref.type === 'node' ? 'This is no longer on the canvas.' : null })
  }

  const rebuild = async (): Promise<void> => {
    setRebuilding(true)
    const r = await searchBridge().rebuild()
    setRebuilding(false)
    if (r.ok) setStats(r.stats)
    else setProblem(r.reason)
  }

  const projectLabel = (h: SearchHit): string => (h.projectName ? `${h.projectName}${h.projectGone ? ' (deleted)' : ''}` : 'No project')

  return (
    <>
      <aside className="drawer search-drawer" aria-label="Search">
        <header className="drawer-head">
          <h2>Search</h2>
          <button className="icon-btn" aria-label="Close search" onClick={closeSearch}>
            ×
          </button>
        </header>
        <div className="search-controls">
          <input
            ref={input}
            className="search-input"
            type="search"
            placeholder="Words or a &quot;quoted phrase&quot;"
            aria-label="Search conversations, notes and messages"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch()
              if (e.key === 'Enter' && hits[0]) open(hits[0])
            }}
          />
          <div className="search-filters">
            <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Every project</option>
              {projectChoices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select aria-label="When" value={range} onChange={(e) => setRange(e.target.value as DateRange)}>
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="search-kinds" role="radiogroup" aria-label="What to search">
            {KINDS.map((k) => (
              <button key={k.id} role="radio" aria-checked={kind === k.id} className={`search-kind${kind === k.id ? ' search-kind-on' : ''}`} onClick={() => setKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
        {problem && <p className="search-problem">{problem}</p>}
        {!text.trim() ? (
          <p className="drawer-empty">Finds text in every agent conversation Patchbay knows, closed ones included, in notes, and in messages agents sent each other. Agents can't use this search.</p>
        ) : !busy && hits.length === 0 && !problem ? (
          <p className="drawer-empty">Nothing found{projectId || range !== 'any' || kind !== 'all' ? ' with these filters' : ''}.</p>
        ) : (
          <ul className="search-results" aria-busy={busy}>
            {hits.map((h) => (
              <li key={h.key} className="search-hit">
                <button className="search-hit-main" onClick={() => open(h)} title="Open where this came from">
                  <span className="search-hit-head">
                    <KindMark hit={h} />
                    <span className="search-hit-title">{h.title}</span>
                    <time className="search-hit-when" dateTime={new Date(h.at).toISOString()}>
                      {h.at ? TIME.format(h.at) : ''}
                    </time>
                  </span>
                  <span className="search-hit-meta">
                    <span className={`search-project${h.projectGone ? ' search-project-gone' : ''}`}>{projectLabel(h)}</span>
                    {h.kind === 'conversation' && h.role && <span>{h.role === 'user' ? 'asked' : 'agent said'}</span>}
                    {h.matches > 1 && <span>{h.matches} matching messages</span>}
                    {h.ref.type === 'closed' && <span>closed</span>}
                  </span>
                  <span className="search-snippet">
                    {markedParts(h.snippet, h.marks).map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                  </span>
                </button>
                {h.kind === 'conversation' && (h.ref.type === 'node' || h.ref.type === 'closed') && (
                  <button
                    className="btn search-continue"
                    onClick={() => openHandoff(h.ref.type === 'node' ? { type: 'node', nodeId: h.ref.nodeId } : { type: 'closed', closedId: (h.ref as { closedId: string }).closedId }, h.title)}
                  >
                    Continue with another agent…
                  </button>
                )}
              </li>
            ))}
            {more && <li className="drawer-empty">More matched. Add words or filters to narrow it down.</li>}
          </ul>
        )}
        <footer className="search-foot">
          <span>
            {stats ? statsLine(stats) : 'Indexing…'}
            {stats?.missing ? ` ${stats.missing} transcript${stats.missing === 1 ? ' is' : 's are'} missing from disk.` : ''}
          </span>
          <button className="btn" disabled={rebuilding} onClick={() => void rebuild()} title="Reads every source again. Transcripts are only read, never changed.">
            {rebuilding ? 'Rebuilding…' : 'Rebuild index'}
          </button>
        </footer>
      </aside>
      {viewing && <SourceViewer viewing={viewing} terms={terms} onClose={() => setViewing(null)} />}
    </>
  )
}
