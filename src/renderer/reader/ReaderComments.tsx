import { useMemo, useState } from 'react'
import { place, sectionLabel } from '../../core/reader/anchor'
import { addComment, editComment, formatComments, inReadingOrder, markSent, removeComment, reopenComment, resolveComment, unsent } from '../../core/reader/comments'
import type { DocOutline } from '../../core/reader/outline'
import { agentOf, AGENT_NAMES, type ReaderNode } from '../../shared/model'
import type { CommentAnchor, ReaderComment } from '../../shared/reader'
import { bridge } from '../bridge'
import { useStore } from '../store'
import { changedAgo, readerTargets } from './targets'
import { requestChanges, useReviewFor } from '../workflows/useReviewFor'

/** A comment being written: on a quote, or on the whole document. */
export interface Draft {
  anchor: CommentAnchor | null
}

const QUOTE_SHOWN = 160
const shortQuote = (q: string): string => (q.length > QUOTE_SHOWN ? `${q.slice(0, QUOTE_SHOWN)}…` : q)

function Composer({ draft, onSave, onCancel }: { draft: Draft; onSave: (text: string) => void; onCancel: () => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const where = draft.anchor ? sectionLabel(draft.anchor.section) : null
  return (
    <div className="reader-composer" data-reader-composer>
      <div className="reader-c-where">{draft.anchor ? <>In {where}</> : <>On the whole document</>}</div>
      {draft.anchor?.quote && <blockquote className="reader-c-quote">{shortQuote(draft.anchor.quote)}</blockquote>}
      <textarea
        autoFocus
        rows={3}
        aria-label="Comment for the agent"
        placeholder={draft.anchor ? 'What should change here?' : 'A comment on the whole document'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) onSave(text)
        }}
      />
      <div className="reader-c-actions">
        <span className="reader-c-hint">Ctrl+Enter</span>
        <button type="button" className="git-mini" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="git-mini reader-primary" disabled={!text.trim()} onClick={() => onSave(text)}>
          Add comment
        </button>
      </div>
    </div>
  )
}

function Card({
  c,
  doc,
  focused,
  now,
  onFocus,
  update
}: {
  c: ReaderComment
  doc: DocOutline
  focused: boolean
  now: number
  onFocus: () => void
  update: (change: (list: ReaderComment[]) => ReaderComment[]) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const p = place(c.anchor, doc)
  const where = p.state === 'document' ? 'Whole document' : p.state === 'anchored' ? sectionLabel(doc.sections[p.section].path) : sectionLabel(c.anchor?.section ?? [])
  return (
    <li
      className={`reader-card${focused ? ' reader-card-focus' : ''}${c.resolved ? ' reader-card-resolved' : ''}`}
      data-comment={c.id}
      data-comment-state={p.state}
    >
      <button type="button" className="reader-c-head" onClick={onFocus} title={p.state === 'anchored' ? 'Show it in the document' : undefined}>
        <span className="reader-c-where">{where}</span>
        {p.state === 'outdated' && <span className="reader-chip reader-chip-outdated" title="The words it was on are no longer in the file">Outdated</span>}
        {c.resolved && <span className="reader-chip">Resolved</span>}
      </button>
      {c.anchor?.quote && <blockquote className={`reader-c-quote${p.state === 'outdated' ? ' reader-c-quote-gone' : ''}`}>{shortQuote(c.anchor.quote)}</blockquote>}
      {editing === null ? (
        <p className="reader-c-text">{c.text}</p>
      ) : (
        <textarea
          autoFocus
          rows={3}
          aria-label="Edit comment"
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(null)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              update((l) => editComment(l, c.id, editing))
              setEditing(null)
            }
          }}
        />
      )}
      <div className="reader-c-foot">
        <span className="reader-c-sent" title={c.sent?.queued ? 'It goes when the agent is idle and you are not typing to it.' : undefined}>
          {c.sent ? `${c.sent.queued ? 'Queued for' : 'Sent to'} ${c.sent.to} ${changedAgo(c.sent.at, now)}` : c.resolved ? '' : 'Not sent yet'}
        </span>
        {editing !== null ? (
          <>
            <button type="button" className="git-mini" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="git-mini reader-primary"
              disabled={!editing.trim()}
              onClick={() => {
                update((l) => editComment(l, c.id, editing))
                setEditing(null)
              }}
            >
              Save
            </button>
          </>
        ) : (
          <>
            {!c.resolved && (
              <button type="button" className="git-mini" onClick={() => setEditing(c.text)}>
                Edit
              </button>
            )}
            <button type="button" className="git-mini" data-comment-action={c.resolved ? 'reopen' : 'resolve'} onClick={() => update((l) => (c.resolved ? reopenComment(l, c.id) : resolveComment(l, c.id)))}>
              {c.resolved ? 'Reopen' : 'Resolve'}
            </button>
            <button
              type="button"
              className={`git-mini${confirmDelete ? ' reader-danger' : ''}`}
              onBlur={() => setConfirmDelete(false)}
              onClick={() => (confirmDelete ? update((l) => removeComment(l, c.id)) : setConfirmDelete(true))}
            >
              {confirmDelete ? 'Delete?' : 'Delete'}
            </button>
          </>
        )}
      </div>
    </li>
  )
}

/** The comments panel: write, list, resolve, and send them to an agent in one message. */
export function ReaderComments({
  node,
  doc,
  comments,
  update,
  draft,
  setDraft,
  focusId,
  onFocus,
  problem,
  now
}: {
  node: ReaderNode
  doc: DocOutline
  comments: ReaderComment[]
  update: (change: (list: ReaderComment[]) => ReaderComment[]) => void
  draft: Draft | null
  setDraft: (d: Draft | null) => void
  focusId: string | null
  onFocus: (id: string) => void
  problem: string | null
  now: number
}): React.JSX.Element {
  const [showResolved, setShowResolved] = useState(false)
  const [to, setTo] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const canvas = useStore((s) => s.doc)
  const targets = useMemo(() => readerTargets(canvas, node), [canvas, node])
  const chosen = targets.find((t) => t.id === to) ?? targets[0]
  const ordered = useMemo(() => inReadingOrder(comments, doc), [comments, doc])
  const resolved = ordered.filter((c) => c.resolved).length
  const shown = showResolved ? ordered : ordered.filter((c) => !c.resolved)
  const sending = unsent(comments)
  // A workflow's review step waiting on this document: Send is its Request changes. See src/renderer/workflows.
  const review = useReviewFor(node.path)

  const send = async (): Promise<void> => {
    if (review && sending.length) {
      const r = await requestChanges(review, formatComments({ title: node.title, path: node.path, comments: sending, doc }))
      if (!r.ok) return setResult({ ok: false, text: r.reason })
      update((l) => markSent(l, sending.map((c) => c.id), review.agent, Date.now(), false))
      return setResult({ ok: true, text: `Sent to ${review.agent} as changes requested at "${review.step}". The workflow reviews it again when ${review.agent} resubmits.` })
    }
    if (!chosen || !sending.length) return
    const text = formatComments({ title: node.title, path: node.path, comments: sending, doc })
    const r = await bridge.sendToAgent(chosen.id, text)
    if (!r.ok) return setResult({ ok: false, text: r.reason })
    update((l) => markSent(l, sending.map((c) => c.id), chosen.title, Date.now(), r.queued))
    setResult({ ok: true, text: r.queued ? `Queued for ${chosen.title}. It goes out when it's idle and you're not typing to it.` : `Sent to ${chosen.title}.` })
  }

  return (
    <aside className="reader-comments" aria-label="Comments" data-reader-ui>
      <div className="reader-comments-head">
        <span className="reader-comments-title">Comments</span>
        <span className="reader-count">{comments.length - resolved}</span>
        {resolved > 0 && (
          <label className="reader-c-toggle">
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Resolved ({resolved})
          </label>
        )}
      </div>
      <div className="reader-comments-list nowheel">
        {draft ? (
          <Composer
            draft={draft}
            onCancel={() => setDraft(null)}
            onSave={(text) => {
              update((l) => addComment(l, { id: crypto.randomUUID(), anchor: draft.anchor, text, at: Date.now() }))
              setDraft(null)
              setResult(null)
            }}
          />
        ) : (
          <button type="button" className="reader-whole" data-reader-whole onClick={() => setDraft({ anchor: null })}>
            + Comment on the whole document
          </button>
        )}
        {problem && <p className="reader-c-problem">{problem}</p>}
        {shown.length === 0 && !draft && <p className="reader-c-empty">Select text, or use the + beside a paragraph or heading, to comment on it.</p>}
        <ul className="reader-cards">
          {shown.map((c) => (
            <Card key={c.id} c={c} doc={doc} focused={c.id === focusId} now={now} onFocus={() => onFocus(c.id)} update={update} />
          ))}
        </ul>
      </div>
      <div className="reader-send">
        {review ? (
          <span className="reader-c-empty" data-reader-review>
            Workflow "{review.workflow}" is waiting on this at "{review.step}". Sending requests changes from {review.agent}.
          </span>
        ) : targets.length === 0 ? (
          <span className="reader-c-empty">Open an agent to send comments to.</span>
        ) : (
          <select aria-label="Send the comments to" value={chosen?.id ?? ''} onChange={(e) => setTo(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} ({AGENT_NAMES[agentOf(t)]}){t.id === node.fromNodeId ? ' · wrote this' : ''}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="git-btn reader-send-btn" data-reader-send disabled={(!chosen && !review) || sending.length === 0} onClick={() => void send()}>
          {review ? `Request changes (${sending.length})` : sending.length ? `Send ${sending.length} ${sending.length === 1 ? 'comment' : 'comments'}` : 'Send comments'}
        </button>
        {result && (
          <span className={result.ok ? 'reader-result' : 'reader-result reader-result-bad'} role="status">
            {result.text}
          </span>
        )}
      </div>
    </aside>
  )
}
