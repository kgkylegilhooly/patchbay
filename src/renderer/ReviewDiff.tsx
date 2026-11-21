import { useMemo, useState } from 'react'
import { create } from 'zustand'
import { agentOf, AGENT_NAMES } from '../shared/model'
import { reviewTargets } from './agentTargets'
import { bridge } from './bridge'
import { formatReview, noteTarget, parseDiff, type ReviewNote } from './reviewNotes'
import { useStore } from './store'

/** Notes per repository root. They last until sent or cleared, across files and while the panel is closed. */
export const useReview = create<{ notes: Record<string, ReviewNote[]> }>(() => ({ notes: {} }))

const NONE: ReviewNote[] = []

function setNotes(root: string, change: (notes: ReviewNote[]) => ReviewNote[]): void {
  useReview.setState((s) => ({ notes: { ...s.notes, [root]: change(s.notes[root] ?? []) } }))
}

/** A diff where any line can take a note. */
export function ReviewDiff({ root, path, text }: { root: string; path: string; text: string }): React.JSX.Element {
  const lines = useMemo(() => parseDiff(text), [text])
  const notes = useReview((s) => s.notes[root] ?? NONE).filter((n) => n.path === path)
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  const save = (index: number): void => {
    const target = noteTarget(lines[index])
    if (!target || !draft.trim()) return
    setNotes(root, (all) => [...all, { id: crypto.randomUUID(), path, ...target, code: lines[index].text, text: draft.trim() }])
    setEditing(null)
    setDraft('')
  }

  return (
    <pre className="git-diff-text review-diff">
      {lines.map((line, i) => {
        const target = noteTarget(line)
        const here = target ? notes.filter((n) => n.line === target.line && n.side === target.side) : []
        const cls = line.kind === 'add' ? 'diff-add' : line.kind === 'del' ? 'diff-del' : line.kind === 'hunk' ? 'diff-hunk' : undefined
        return (
          <span key={i} className="review-line-wrap">
            <span className={`review-line ${cls ?? ''}`} data-diff-line={i}>
              {target ? (
                <button
                  type="button"
                  className="review-add"
                  data-review-add={i}
                  aria-label={`Add a note on ${target.side === 'new' ? 'line' : 'removed line'} ${target.line}`}
                  title="Add a note for the agent"
                  onClick={() => {
                    setEditing(i)
                    setDraft('')
                  }}
                >
                  +
                </button>
              ) : (
                <span className="review-add-gap" />
              )}
              <span className="review-num">{target ? target.line : ''}</span>
              {line.text}
              {'\n'}
            </span>
            {here.map((n) => (
              <span key={n.id} className="review-note" data-review-note={n.id}>
                <span className="review-note-text">{n.text}</span>
                <button type="button" className="review-note-remove" aria-label="Remove this note" onClick={() => setNotes(root, (all) => all.filter((x) => x.id !== n.id))}>
                  ×
                </button>
                {'\n'}
              </span>
            ))}
            {editing === i && (
              <span className="review-edit">
                <textarea
                  autoFocus
                  aria-label="Note for the agent"
                  placeholder="What should change here?"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null)
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(i)
                  }}
                />
                <span className="review-edit-actions">
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-sm btn-quiet review-save" disabled={!draft.trim()} onClick={() => save(i)}>
                    Add note
                  </button>
                </span>
                {'\n'}
              </span>
            )}
          </span>
        )
      })}
    </pre>
  )
}

/** How many notes there are, who they go to, and Send. */
export function ReviewBar({ root }: { root: string }): React.JSX.Element | null {
  const notes = useReview((s) => s.notes[root] ?? NONE)
  const doc = useStore((s) => s.doc)
  const targets = useMemo(() => reviewTargets(doc, root), [doc, root])
  const [to, setTo] = useState<string>('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  if (notes.length === 0 && !result) return null
  const chosen = targets.find((t) => t.id === to) ?? targets[0]
  const repoName = root.split(/[\\/]/).filter(Boolean).pop() ?? root

  const send = async (): Promise<void> => {
    if (!chosen) return
    const r = await bridge.sendToAgent(chosen.id, formatReview(notes, repoName))
    if (!r.ok) return setResult({ ok: false, text: r.reason })
    setNotes(root, () => [])
    setResult({ ok: true, text: r.queued ? `Queued for ${chosen.title}. It goes out when it's idle.` : `Sent to ${chosen.title}.` })
  }

  return (
    <div className="review-bar" role="region" aria-label="Review">
      {notes.length > 0 && (
        <>
          <span className="review-count">
            {notes.length} {notes.length === 1 ? 'note' : 'notes'}
          </span>
          {targets.length === 0 ? (
            <span className="review-none">Open an agent to send these to.</span>
          ) : (
            <select aria-label="Send the review to" value={chosen?.id ?? ''} onChange={(e) => setTo(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} ({AGENT_NAMES[agentOf(t)]})
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-sm" data-review="send" disabled={!chosen} onClick={() => void send()}>
            Send review
          </button>
          <button type="button" className="btn btn-sm btn-quiet" data-review="clear" onClick={() => setNotes(root, () => [])}>
            Clear
          </button>
        </>
      )}
      {result && (
        <span className={result.ok ? 'review-result' : 'review-result review-result-bad'} role="status">
          {result.text}
          <button type="button" className="btn btn-sm btn-quiet" aria-label="Dismiss" onClick={() => setResult(null)}>
            ×
          </button>
        </span>
      )}
    </div>
  )
}
