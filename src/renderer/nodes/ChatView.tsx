import { useEffect, useRef, useState } from 'react'
import { agentOf, AGENT_NAMES, type ClaudeNode } from '../../shared/model'
import { bridge } from '../bridge'
import { copiedCode, flashCopied, renderMarkdown } from '../stickyRender'
import { useStore } from '../store'
import { useLinkMenu } from '../useLinkMenu'

type Message = { role: 'user' | 'assistant'; text: string }

/** The conversation grows while it's open, so it's read again this often. */
const REFRESH_MS = 2000

const STATUS_LINE: Partial<Record<string, string>> = {
  working: 'Working…',
  'needs-you': 'Waiting for you. Answer in the terminal view.',
  starting: 'Starting…',
  queued: 'Waiting for another agent to finish first.',
  exited: 'This session has ended.'
}

/**
 * An agent window's conversation as messages, from its own transcript, with a box for the next one. Replies are
 * agent output, so their Markdown is drawn through the same sanitizer as sticky notes.
 */
export function ChatView({ node }: { node: ClaudeNode }): React.JSX.Element {
  const status = useStore((s) => s.statuses[node.id] ?? 'unknown')
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const links = useLinkMenu(node.id)
  const pinned = useRef(true)

  useEffect(() => {
    let live = true
    const read = (): void => {
      void bridge.readConversation(node.id).then((r) => {
        if (!live) return
        if (!r.ok) return setProblem(r.reason)
        setProblem(null)
        setMessages((old) => (old && old.length === r.messages.length && old.at(-1)?.text === r.messages.at(-1)?.text ? old : r.messages))
      })
    }
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [node.id, status])

  // Stays at the newest message, unless the person has scrolled up to read.
  useEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    const r = await bridge.sendToAgent(node.id, text)
    if (!r.ok) return setSent(r.reason)
    setDraft('')
    setSent(r.queued ? 'Queued. It goes out when the agent is idle.' : null)
    pinned.current = true
  }

  const name = AGENT_NAMES[agentOf(node)]
  return (
    <div className="chat nodrag nowheel nopan" data-chat={node.id}>
      <div
        className="chat-list"
        ref={list}
        onContextMenu={links.onContextMenu}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        // Links must never navigate the app window. They go out through main, which checks them, as from a sticky note.
        onClick={(e) => {
          const code = copiedCode(e.target)
          if (code !== null) return void navigator.clipboard.writeText(code).then(() => flashCopied(e.target))
          const link = (e.target as HTMLElement).closest('a')
          if (!link) return
          e.preventDefault()
          const href = link.getAttribute('href')
          if (href) void bridge.openTerminalLink(node.id, href)
        }}
      >
        {messages === null && !problem && <p className="chat-empty">Loading…</p>}
        {problem && <p className="chat-empty chat-problem">{problem}</p>}
        {messages?.length === 0 && <p className="chat-empty">No messages yet. What you and {name} say appears here.</p>}
        {messages?.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`} data-chat-role={m.role}>
            <div className="chat-who">{m.role === 'user' ? 'You' : name}</div>
            {m.role === 'assistant' ? <div className="chat-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} /> : <div className="chat-text chat-plain">{m.text}</div>}
          </div>
        ))}
        {STATUS_LINE[status] && <p className="chat-status">{STATUS_LINE[status]}</p>}
      </div>
      {links.menu}
      {links.notice && (
        <p className="link-notice" role="status">
          {links.notice}
        </p>
      )}
      <form
        className="chat-box"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          aria-label={`Message ${node.title}`}
          placeholder={`Message ${name}. Enter sends, Shift+Enter adds a line.`}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button type="submit" className="btn btn-solid" data-chat-send disabled={!draft.trim() || status === 'exited'}>
          Send
        </button>
      </form>
      {sent && (
        <p className="chat-sent" role="status">
          {sent}
        </p>
      )}
    </div>
  )
}
