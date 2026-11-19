import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isSessionNode } from '../shared/model'
import type { SessionPeek } from '../shared/needsYouBridge'
import { actionById } from './actions'
import { bridge } from './bridge'
import { currentKey } from './keys'
import type { Commands } from './menus'
import { StatusBadge, StatusDot } from './nodes/StatusBadge'
import { queuedText, waitText, whatItAsks } from './needsYou'
import { closePeek, jumpToNext, needsYouBridge, setIncludeUnread, useNeedsYouUi, type PeekPlace } from './needsYouUi'
import { useStore } from './store'

/** How often an open peek reads the conversation again, so a reply that arrives shows. */
const REFRESH_MS = 4000
const TICK_MS = 20_000

type Sent = { kind: 'sent' | 'queued' | 'error'; text: string } | null

/**
 * A compact look at one agent window without going to it: what it last said, what it's asking for, how long it has
 * waited, and a box to answer it in. The answer goes the way typed messages from a review do, through the send
 * queue, so it never lands on a permission prompt: approving or denying stays in the window, which "Open" goes to.
 */
export function PeekCard({ id, place, commands }: { id: string; place: PeekPlace; commands: Commands }): React.JSX.Element | null {
  const node = useStore((s) => s.doc?.nodes.find((n) => n.id === id))
  const project = useStore((s) => s.doc?.projects.find((p) => p.id === node?.projectId))
  const status = useStore((s) => s.statuses[id] ?? (node?.kind === 'claude' ? 'unknown' : null))
  const approval = useStore((s) => s.approvals.find((a) => a.nodeId === id))
  const unread = useStore((s) => s.attention.includes(id))
  const includeUnread = useNeedsYouUi((s) => s.includeUnread)
  const overrides = useStore((s) => s.keyOverrides)
  const [peek, setPeek] = useState<SessionPeek | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<Sent>(null)
  const [sending, setSending] = useState(false)
  const [now, setNow] = useState(Date.now)
  const card = useRef<HTMLDivElement>(null)
  const said = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPeek(null)
    setFailed(null)
    setDraft('')
    setSent(null)
  }, [id])

  // Read again on a status change and every few seconds, so a peek left open keeps up.
  useEffect(() => {
    let live = true
    const read = (): void => {
      needsYouBridge()
        .peek(id)
        .then((r) => {
          if (!live) return
          if (r.ok) {
            setPeek(r.peek)
            setFailed(null)
          } else setFailed(r.reason)
        })
        .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)))
      setNow(Date.now())
    }
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [id, status])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // The end of a long message is where the question usually is.
  useLayoutEffect(() => {
    if (said.current) said.current.scrollTop = said.current.scrollHeight
  }, [peek?.lastMessage])

  // Closes on a press outside it, and on Esc from inside it. A terminal keeps its own Esc, which interrupts Claude.
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Element | null
      if (card.current?.contains(target) || target?.closest?.('[data-peek]')) return
      closePeek()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [])

  if (!node || !isSessionNode(node) || node.kind !== 'claude') return null

  const wait = waitText(status, peek?.since ?? null, now)
  const asking = whatItAsks(status, approval && { tool: approval.tool, summary: approval.summary }, peek?.pending)
  const nextKey = (() => {
    const action = actionById('next-needs-you')
    return action ? currentKey(action, overrides) : null
  })()

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const r = await bridge.sendToAgent(id, text)
      if (!r.ok) setSent({ kind: 'error', text: r.reason })
      else {
        setDraft('')
        setSent(r.queued ? { kind: 'queued', text: queuedText(status) } : { kind: 'sent', text: 'Sent.' })
      }
    } catch (e) {
      setSent({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSending(false)
    }
  }

  const open = (): void => {
    closePeek()
    commands.revealNode(id)
  }

  const style: React.CSSProperties | undefined = place.from === 'sidebar' ? { left: place.x, top: Math.max(8, Math.min(place.y, window.innerHeight - 440)) } : undefined

  return (
    <div
      ref={card}
      className={`pop peek peek-${place.from}`}
      style={style}
      role="dialog"
      aria-label={`Peek at ${node.title}`}
      data-peek-card={id}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closePeek()
        }
      }}
    >
      <div className="peek-head">
        <StatusDot status={status} />
        <span className="peek-title" title={node.title}>
          {node.title}
        </span>
        {status && <StatusBadge status={status} />}
        <button type="button" className="icon-btn" aria-label="Close peek" title="Close (Esc)" onClick={closePeek}>
          ×
        </button>
      </div>
      <div className="peek-meta">
        {project && <span>{project.name}</span>}
        {wait && <span title={wait.title}>{wait.text}</span>}
        {unread && status !== 'needs-you' && <span>Not looked at yet</span>}
      </div>

      {status === 'needs-you' && (
        <div className="peek-asking" data-peek-asking>
          {asking?.kind === 'subagent' ? (
            <span className="peek-label">A subagent is asking. Open its window to see.</span>
          ) : asking ? (
            <>
              <span className="peek-label">Waiting on you to allow or answer</span>
              <span className="peek-tool">{asking.tool}</span>
              {asking.summary && <code className="peek-call">{asking.summary}</code>}
            </>
          ) : (
            <span className="peek-label">Patchbay can't tell what it's asking. Open its window to see.</span>
          )}
        </div>
      )}

      <div className="peek-said" ref={said} data-peek-said>
        {failed ? <p className="peek-problem">{failed}</p> : peek === null ? <p className="peek-dim">Reading its conversation…</p> : peek.problem ? <p className="peek-problem">{peek.problem}</p> : peek.lastMessage ? <p className="peek-text">{peek.lastMessage}</p> : <p className="peek-dim">It hasn't said anything yet.</p>}
      </div>

      <form
        className="peek-reply"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          aria-label={`Reply to ${node.title}`}
          placeholder={status === 'exited' ? 'It has exited. Restart it to reply.' : 'Reply… (Enter sends, Shift+Enter for a new line)'}
          rows={2}
          value={draft}
          disabled={status === 'exited'}
          onChange={(e) => {
            setDraft(e.target.value)
            if (sent?.kind !== 'error') setSent(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {sent && (
          <p className={`peek-sent peek-sent-${sent.kind}`} role="status">
            {sent.text}
          </p>
        )}
        <div className="peek-actions">
          {place.from === 'jump' && (
            <label className="peek-check" title="After those waiting on you, go to sessions that finished or stopped while you were elsewhere">
              <input type="checkbox" checked={includeUnread} onChange={(e) => setIncludeUnread(e.target.checked)} />
              Also unread
            </label>
          )}
          <span className="peek-grow" />
          <button type="button" className="btn" onClick={open} title="Go to its window, to approve, deny or look around">
            Open
          </button>
          {place.from === 'jump' && (
            <button type="button" className="btn" onClick={() => void jumpToNext(commands)} title={nextKey ? `Next needing you (${nextKey})` : 'Next needing you'}>
              Next{nextKey ? ` · ${nextKey}` : ''}
            </button>
          )}
          <button type="submit" className="btn btn-solid" disabled={!draft.trim() || sending || status === 'exited'}>
            Send
          </button>
        </div>
      </form>
    </div>
  )
}
