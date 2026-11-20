import type { NodeProps } from '@xyflow/react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { place, quoteOf } from '../../core/reader/anchor'
import { hiddenBy, outline, type DocOutline } from '../../core/reader/outline'
import type { ReaderNode as ReaderModel } from '../../shared/model'
import type { CommentAnchor, ReaderComment } from '../../shared/reader'
import { copyText } from '../clipboard'
import type { FlowNode } from '../flowMapping'
import { EditableTitle, Jacks, Resizer } from '../nodes/NodeChrome'
import { copiedCode, flashCopied } from '../stickyRender'
import { closeNodes } from '../store'
import { useHeaderZoom } from '../useHeaderZoom'
import { ReaderComments, type Draft } from './ReaderComments'
import { ReaderIcon } from './ReaderIcon'
import { docsBridge, samePath } from './readerBridge'
import { findQuote, rangeText, sectionOf, setHighlights, visibleText } from './quoteRange'
import { enhanceBlocks } from './enhance'
import { renderBlocks, renderHeading } from './render'
import { changedAgo, slug } from './targets'
import './reader.css'

/** Blocks a comment can be put on with the + beside them. */
const BLOCKS = 'p, li, blockquote, .code-block, table, .reader-heading'
const PAPER_KEY = 'patchbay.reader.paper'
const WIDE = 900

function readPaper(): boolean {
  try {
    return localStorage.getItem(PAPER_KEY) === '1'
  } catch {
    return false
  }
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

interface Loaded {
  text: string
  mtimeMs: number
  /** Why the file can't be read now. The last text read stays shown. */
  problem: string | null
  /** When a change on disk was last picked up, for the header's flash. */
  updatedAt: number | null
}

/** The file, read now and again whenever main says it changed. */
function useDocument(node: ReaderModel, beforeChange: () => void): { loaded: Loaded | null; first: string | null } {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [first, setFirst] = useState<string | null>(null)
  const before = useRef(beforeChange)
  before.current = beforeChange

  useEffect(() => {
    let live = true
    const load = async (fromWatch: boolean): Promise<void> => {
      const r = await docsBridge().read(node.id)
      if (!live) return
      if (!r.ok) {
        setLoaded((l) => (l ? { ...l, problem: r.reason } : null))
        setFirst((f) => f ?? r.reason)
        return
      }
      setFirst(null)
      setLoaded((l) => {
        if (l && l.text === r.text && !l.problem) return l.mtimeMs === r.mtimeMs ? l : { ...l, mtimeMs: r.mtimeMs }
        if (l && l.text !== r.text) before.current()
        return { text: r.text, mtimeMs: r.mtimeMs, problem: null, updatedAt: fromWatch && l ? Date.now() : (l?.updatedAt ?? null) }
      })
    }
    void load(false)
    const off = docsBridge().onChanged((path) => {
      if (samePath(path, node.path)) void load(true)
    })
    return () => {
      live = false
      off()
    }
  }, [node.id, node.path])
  return { loaded, first }
}

/** The comments on the file, saved in main whenever they change. */
function useComments(nodeId: string): { comments: ReaderComment[]; update: (change: (list: ReaderComment[]) => ReaderComment[]) => void; problem: string | null } {
  const [comments, setComments] = useState<ReaderComment[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const latest = useRef(comments)
  useEffect(() => {
    let live = true
    void docsBridge()
      .comments(nodeId)
      .then((r) => {
        if (!live) return
        if (r.ok) {
          latest.current = r.comments
          setComments(r.comments)
        } else setProblem(r.reason)
      })
    return () => {
      live = false
    }
  }, [nodeId])
  const update = useCallback(
    (change: (list: ReaderComment[]) => ReaderComment[]) => {
      const next = change(latest.current)
      if (next === latest.current) return
      latest.current = next
      setComments(next)
      void docsBridge()
        .saveComments(nodeId, next)
        .then((r) => setProblem(r.ok ? null : `Comments couldn't be saved: ${r.reason}`))
    },
    [nodeId]
  )
  return { comments, update, problem }
}

/** One section: its heading, with collapse and comment controls, and its blocks. Drawn again only when it changes. */
const Section = memo(function Section({
  index,
  doc,
  collapsed,
  hidden,
  count,
  onToggle,
  onShowComments,
  nodeId,
  version
}: {
  index: number
  doc: DocOutline
  collapsed: boolean
  hidden: boolean
  count: number
  onToggle: (i: number) => void
  onShowComments: (i: number) => void
  nodeId: string
  /** The file's modification time: pictures are read again when it changes. */
  version: number
}): React.JSX.Element {
  const s = doc.sections[index]
  const html = useMemo(() => (collapsed ? '' : renderBlocks(s.body)), [s, collapsed])
  const blocksRef = useRef<HTMLDivElement>(null)
  // Local pictures, put in after the cleaned HTML is on the page.
  useLayoutEffect(() => {
    const el = blocksRef.current
    if (!el || !html) return
    return enhanceBlocks(el, { nodeId, version })
  }, [html, nodeId, version])
  const heading = useMemo(() => (s.heading ? renderHeading(s.heading) : ''), [s])
  const H = `h${Math.min(6, Math.max(1, s.depth))}` as 'h1'
  return (
    <section className="reader-section" data-section={index} data-depth={s.depth} hidden={hidden}>
      {s.heading && (
        <div className={`reader-heading reader-h${s.depth}`} id={slug(s.title)}>
          <button type="button" className="reader-fold" data-reader-ui aria-label={collapsed ? `Expand ${s.title}` : `Collapse ${s.title}`} aria-expanded={!collapsed} onClick={() => onToggle(index)}>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
              <path d={collapsed ? 'M4 2.5 8 6l-4 3.5' : 'M2.5 4 6 8l3.5-4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <H dangerouslySetInnerHTML={{ __html: heading }} />
          {count > 0 && (
            <button type="button" className="reader-pin" data-reader-ui title="Show comments on this section" onClick={() => onShowComments(index)}>
              {count}
            </button>
          )}
        </div>
      )}
      {!collapsed && <div className="reader-blocks" ref={blocksRef} dangerouslySetInnerHTML={{ __html: html }} />}
    </section>
  )
})

/** A Markdown file, read-only, with an outline and comments to send to an agent. */
export const ReaderNode = memo(function ReaderNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as ReaderModel
  const headerZoom = useHeaderZoom(node.id)
  const scrollRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLElement>(null)
  const keep = useRef<{ index: number; title: string; delta: number } | null>(null)
  const titles = useRef<string[]>([])
  const now = useNow(30_000)

  /** Where the reader is, so a reload can come back to the same words. */
  const rememberPlace = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const top = scroll.getBoundingClientRect().top
    const scale = scroll.getBoundingClientRect().height / (scroll.offsetHeight || 1)
    for (const el of scroll.querySelectorAll<HTMLElement>('[data-section]')) {
      const r = el.getBoundingClientRect()
      if (r.bottom > top) {
        const index = Number(el.dataset.section)
        keep.current = { index, title: titles.current[index] ?? '', delta: (top - r.top) / scale }
        return
      }
    }
  }, [])
  const { loaded, first } = useDocument(node, () => rememberPlace())
  const doc = useMemo(() => outline(loaded?.text ?? ''), [loaded?.text])
  titles.current = doc.sections.map((s) => s.title)
  const { comments, update, problem } = useComments(node.id)

  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  const [outlineOpen, setOutlineOpen] = useState<boolean | null>(null)
  const [commentsOpen, setCommentsOpen] = useState<boolean | null>(null)
  const [paper, setPaper] = useState(readPaper)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [hover, setHover] = useState<{ top: number; anchor: CommentAnchor } | null>(null)
  const [bubble, setBubble] = useState<{ top: number; left: number; anchor: CommentAnchor } | null>(null)
  const [linkProblem, setLinkProblem] = useState<string | null>(null)

  const openCount = comments.filter((c) => !c.resolved).length
  const showOutline = outlineOpen ?? node.width >= WIDE
  const showComments = commentsOpen ?? (openCount > 0 || draft !== null)
  const hidden = useMemo(() => hiddenBy(doc.sections, collapsed), [doc, collapsed])

  // Comments per section, for the count beside each heading.
  const perSection = useMemo(() => {
    const counts = new Map<number, number>()
    for (const c of comments) {
      if (c.resolved) continue
      const p = place(c.anchor, doc)
      if (p.state === 'anchored') counts.set(p.section, (counts.get(p.section) ?? 0) + 1)
    }
    return counts
  }, [comments, doc])

  // After a reload, back to the same words.
  useLayoutEffect(() => {
    const k = keep.current
    const scroll = scrollRef.current
    if (!k || !scroll) return
    keep.current = null
    const match = doc.sections[k.index]?.title === k.title ? k.index : doc.sections.findIndex((s) => s.title === k.title)
    const el = scroll.querySelector<HTMLElement>(`[data-section="${match < 0 ? Math.min(k.index, doc.sections.length - 1) : match}"]`)
    if (!el) return
    const scale = scroll.getBoundingClientRect().height / (scroll.offsetHeight || 1)
    scroll.scrollTop += (el.getBoundingClientRect().top - scroll.getBoundingClientRect().top) / scale + k.delta
  }, [doc])

  // Marks every open comment's words, and the focused one more strongly.
  useLayoutEffect(() => {
    const article = docRef.current
    if (!article) return
    const quotes: Range[] = []
    const focus: Range[] = []
    for (const c of comments) {
      if (c.resolved || !c.anchor?.quote) continue
      const p = place(c.anchor, doc)
      if (p.state !== 'anchored') continue
      const section = article.querySelector(`[data-section="${p.section}"]`)
      const range = (section && findQuote(section, c.anchor.quote)) ?? findQuote(article, c.anchor.quote)
      if (!range) continue
      if (c.id === focusId) focus.push(range)
      else quotes.push(range)
    }
    setHighlights(node.id, quotes, focus)
  }, [comments, doc, collapsed, focusId, node.id, loaded])
  useEffect(() => () => setHighlights(node.id, []), [node.id])

  // A selection that ends goes with its bubble.
  useEffect(() => {
    const changed = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setBubble(null)
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [])

  const scale = (): number => {
    const el = docRef.current
    return el ? el.getBoundingClientRect().width / (el.offsetWidth || 1) : 1
  }

  const jumpTo = (index: number): void => {
    const scroll = scrollRef.current
    const el = scroll?.querySelector<HTMLElement>(`[data-section="${index}"]`)
    if (!scroll || !el) return
    // A heading inside a collapsed one opens its way there.
    setCollapsed((c) => {
      const next = new Set(c)
      for (let i = index - 1, depth = doc.sections[index].depth; i >= 0 && depth > 1; i--) {
        if (doc.sections[i].depth < depth) {
          next.delete(i)
          depth = doc.sections[i].depth
        }
      }
      return next.size === c.size ? c : next
    })
    requestAnimationFrame(() => {
      const s = scale()
      scroll.scrollTop += (el.getBoundingClientRect().top - scroll.getBoundingClientRect().top) / s - 6
    })
  }

  const focusComment = (id: string): void => {
    setFocusId(id)
    const c = comments.find((x) => x.id === id)
    const p = c ? place(c.anchor, doc) : null
    if (p?.state === 'anchored') jumpTo(p.section)
  }

  const onScroll = (): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    const top = scroll.getBoundingClientRect().top + 8
    let current = 0
    for (const el of scroll.querySelectorAll<HTMLElement>('[data-section]')) {
      if (el.hidden) continue
      if (el.getBoundingClientRect().top <= top) current = Number(el.dataset.section)
      else break
    }
    setActive(current)
    setHover(null)
  }

  const anchorFor = (section: HTMLElement | null, text: string): CommentAnchor => ({
    section: section ? (doc.sections[Number(section.dataset.section)]?.path ?? []) : [],
    quote: quoteOf(text)
  })

  const onMove = (e: React.MouseEvent): void => {
    const article = docRef.current
    const target = e.target instanceof Element ? e.target : null
    if (!article || !target || target.closest('[data-reader-ui]')) return
    const block = target.closest(BLOCKS)
    if (!block || !article.contains(block)) return
    // The innermost list item, not the list holding it.
    const top = (block.getBoundingClientRect().top - article.getBoundingClientRect().top) / scale()
    const text = block.classList.contains('reader-heading') ? doc.sections[Number(sectionOf(block)?.dataset.section)]?.title ?? '' : visibleText(block)
    if (hover?.top === top) return
    setHover({ top, anchor: anchorFor(sectionOf(block), text) })
  }

  const onMouseUp = (): void => {
    // After the browser has settled the selection.
    setTimeout(() => {
      const article = docRef.current
      const sel = window.getSelection()
      if (!article || !sel || sel.isCollapsed || !sel.rangeCount) return
      const range = sel.getRangeAt(0)
      if (!article.contains(range.commonAncestorContainer)) return
      const text = rangeText(range)
      if (!text.trim()) return
      const r = range.getBoundingClientRect()
      const base = article.getBoundingClientRect()
      const s = scale()
      setBubble({ top: (r.top - base.top) / s, left: (r.left + r.width / 2 - base.left) / s, anchor: anchorFor(sectionOf(range.startContainer), text) })
    }, 0)
  }

  const startComment = (anchor: CommentAnchor | null): void => {
    setDraft({ anchor })
    setCommentsOpen(true)
    setBubble(null)
    window.getSelection()?.removeAllRanges()
  }

  const onClick = (e: React.MouseEvent): void => {
    const code = copiedCode(e.target)
    if (code !== null) {
      void copyText(code).then(() => flashCopied(e.target))
      return
    }
    const link = e.target instanceof Element ? e.target.closest('a') : null
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      const want = decodeURIComponent(href.slice(1)).toLowerCase()
      const i = doc.sections.findIndex((s) => s.title && slug(s.title) === want)
      if (i >= 0) jumpTo(i)
      return
    }
    void docsBridge()
      .openLink(node.id, href)
      .then((r) => setLinkProblem(r.ok ? null : r.reason))
  }

  const togglePaper = (): void => {
    setPaper((p) => {
      try {
        localStorage.setItem(PAPER_KEY, p ? '0' : '1')
      } catch {
        // Remembering it is only a convenience.
      }
      return !p
    })
  }

  const onToggle = useCallback((i: number) => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }, [])
  const onShowComments = useCallback(
    (i: number) => {
      setCommentsOpen(true)
      const c = comments.find((x) => {
        const p = place(x.anchor, doc)
        return !x.resolved && p.state === 'anchored' && p.section === i
      })
      if (c) setFocusId(c.id)
    },
    [comments, doc]
  )

  const folder = node.path.replace(/[\\/][^\\/]*$/, '')
  const updated = loaded?.updatedAt && now - loaded.updatedAt < 60_000 && Date.now() - loaded.updatedAt < 60_000
  const outlineItems = doc.sections.filter((s) => s.depth > 0)

  return (
    <div className={`unit reader${paper ? ' reader-paper' : ''}${selected ? ' unit-selected' : ''}`} data-reader={node.id}>
      <Resizer node={node} min={{ w: 420, h: 300 }} />
      <Jacks />
      <header className="unit-head pb-drag" onDoubleClick={headerZoom}>
        <ReaderIcon />
        <EditableTitle node={node} />
        <span className="cwd" title={node.path}>
          {folder}
        </span>
        {loaded && (
          <span className={`reader-changed${updated ? ' reader-changed-now' : ''}`} key={loaded.updatedAt ?? 0} title={`The file last changed ${new Date(loaded.mtimeMs).toLocaleString()}`}>
            {updated ? 'Updated' : 'Changed'} {changedAgo(updated ? loaded.updatedAt! : loaded.mtimeMs, Math.max(now, Date.now()))}
          </span>
        )}
        <span className="reader-tools nodrag">
          <button type="button" className={`reader-tool${showOutline ? ' reader-tool-on' : ''}`} aria-pressed={showOutline} title="Outline" onClick={() => setOutlineOpen(!showOutline)}>
            Outline
          </button>
          <button type="button" className={`reader-tool${paper ? ' reader-tool-on' : ''}`} aria-pressed={paper} title="A light page for long reading" onClick={togglePaper}>
            Paper
          </button>
          <button type="button" className={`reader-tool${showComments ? ' reader-tool-on' : ''}`} aria-pressed={showComments} data-reader-comments-toggle onClick={() => setCommentsOpen(!showComments)}>
            Comments{openCount ? ` ${openCount}` : ''}
          </button>
        </span>
        <button className="icon-btn nodrag" aria-label={`Close ${node.title}`} title="Close reader" onClick={() => closeNodes([node.id])}>
          ×
        </button>
      </header>
      <div className="reader-main nodrag nowheel">
        {showOutline && (
          <nav className="reader-toc" aria-label="Outline">
            {outlineItems.length === 0 && <p className="reader-c-empty">No headings.</p>}
            {outlineItems.map((s) => (
              <button
                type="button"
                key={s.index}
                className={`reader-toc-item${s.index === active ? ' reader-toc-active' : ''}${hidden.has(s.index) ? ' reader-toc-hidden' : ''}`}
                style={{ paddingLeft: 8 + (s.depth - 1) * 12 }}
                onClick={() => jumpTo(s.index)}
              >
                <span>{s.title}</span>
                {perSection.get(s.index) ? <em>{perSection.get(s.index)}</em> : null}
              </button>
            ))}
          </nav>
        )}
        <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
          {(loaded?.problem || linkProblem) && (
            <p className="reader-banner" role="status">
              {loaded?.problem ? `${loaded.problem} Showing the last version read.` : linkProblem}
              {linkProblem && !loaded?.problem && (
                <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setLinkProblem(null)}>
                  ×
                </button>
              )}
            </p>
          )}
          {!loaded && <p className="reader-empty">{first ?? 'Reading…'}</p>}
          {loaded && (
            <article className="reader-doc md" ref={docRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onMouseUp={onMouseUp} onClick={onClick}>
              {doc.sections.length === 0 && <p className="reader-empty">The file is empty.</p>}
              {doc.sections.map((s) => (
                <Section
                  key={`${s.index}:${s.title}`}
                  index={s.index}
                  doc={doc}
                  collapsed={collapsed.has(s.index)}
                  hidden={hidden.has(s.index)}
                  count={perSection.get(s.index) ?? 0}
                  onToggle={onToggle}
                  onShowComments={onShowComments}
                  nodeId={node.id}
                  version={loaded.mtimeMs}
                />
              ))}
              {hover && !bubble && (
                <button type="button" className="reader-add" data-reader-ui style={{ top: hover.top }} title="Comment on this" aria-label="Comment on this" onClick={() => startComment(hover.anchor)}>
                  +
                </button>
              )}
              {bubble && (
                <button
                  type="button"
                  className="reader-bubble"
                  data-reader-ui
                  style={{ top: bubble.top, left: bubble.left }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => startComment(bubble.anchor)}
                >
                  Comment
                </button>
              )}
            </article>
          )}
        </div>
        {showComments && (
          <ReaderComments
            node={node}
            doc={doc}
            comments={comments}
            update={update}
            draft={draft}
            setDraft={setDraft}
            focusId={focusId}
            onFocus={focusComment}
            problem={problem}
            now={now}
          />
        )}
      </div>
    </div>
  )
})
