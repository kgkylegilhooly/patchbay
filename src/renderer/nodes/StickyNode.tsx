import type { NodeProps } from '@xyflow/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { StickyNode as StickyModel } from '../../shared/model'
import { bridge } from '../bridge'
import type { FlowNode } from '../flowMapping'
import { CODE_LANGUAGES } from '../highlight'
import { Icon, type IconName } from '../icons'
import { codeBlock, indent, link, prefixLines, toggleTask, wrap, type TextEdit } from '../noteEdit'
import { relativeTime } from '../sidebarView'
import { closeNodes, patchNode, useStore } from '../store'
import { copiedCode, flashCopied, noteMarkdown } from '../stickyRender'
import { EditableTitle, Jacks, Resizer } from './NodeChrome'
import { useLinkMenu } from '../useLinkMenu'
import { useHeaderZoom } from '../useHeaderZoom'
import { noteTile } from '../farTiles'
import { linkedAgents, sendSummary, sendTitle, type SendResult } from '../noteSend'

/** The first is the default, the tape yellow notes have always been. */
export const NOTE_COLORS = ['#d9c64a', '#e8806f', '#6fc08a', '#6fa8f0', '#b08cf0', '#9a9aa2']

/** A saved color is only used if it's a plain hex color, because it goes into CSS. */
export const noteColor = (color: string | undefined): string => (color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : NOTE_COLORS[0])

type Tool = { icon: IconName; label: string; keys?: string; edit: (text: string, from: number, to: number) => TextEdit }

const TOOLS: Tool[][] = [
  [
    { icon: 'bold', label: 'Bold', keys: 'Ctrl+B', edit: (t, a, b) => wrap(t, a, b, '**', 'bold') },
    { icon: 'italic', label: 'Italic', keys: 'Ctrl+I', edit: (t, a, b) => wrap(t, a, b, '_', 'italic') },
    { icon: 'heading', label: 'Heading', edit: (t, a, b) => prefixLines(t, a, b, '## ') }
  ],
  [
    { icon: 'list', label: 'Bulleted list', edit: (t, a, b) => prefixLines(t, a, b, '- ') },
    { icon: 'checklist', label: 'Checklist', edit: (t, a, b) => prefixLines(t, a, b, '- [ ] ') },
    { icon: 'quote', label: 'Quote', edit: (t, a, b) => prefixLines(t, a, b, '> ') }
  ],
  [
    { icon: 'link', label: 'Link', edit: link },
    { icon: 'code-inline', label: 'Inline code', keys: 'Ctrl+E', edit: (t, a, b) => wrap(t, a, b, '`', 'code') }
  ]
]

const KEYED: Record<string, Tool> = { b: TOOLS[0][0], i: TOOLS[0][1], e: TOOLS[2][1] }

/** Keeps focus in the text while a toolbar button is pressed, so the selection survives the click. */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

function Editor({ node, onDone }: { node: StickyModel; onDone: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState(node.text)
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  const save = (): void => {
    if (draft !== node.text) patchNode(node.id, { text: draft })
    onDone()
  }

  // As a native edit, so Ctrl+Z in the text undoes a toolbar change like any typing.
  const apply = (make: (text: string, from: number, to: number) => TextEdit): void => {
    const el = box.current
    if (!el) return
    const e = make(el.value, el.selectionStart, el.selectionEnd)
    el.focus()
    el.setSelectionRange(e.from, e.to)
    const done = e.insert ? document.execCommand('insertText', false, e.insert) : document.execCommand('delete')
    if (!done) setDraft(el.value.slice(0, e.from) + e.insert + el.value.slice(e.to))
    requestAnimationFrame(() => el.setSelectionRange(e.select[0], e.select[1]))
  }

  return (
    <div
      className="note-editor nodrag nowheel"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save()
      }}
    >
      <div className="note-toolbar" role="toolbar" aria-label="Formatting">
        {TOOLS.map((group, i) => (
          <span className="note-tool-group" key={i}>
            {group.map((t) => (
              <button
                key={t.label}
                type="button"
                className="icon-btn note-tool"
                aria-label={t.label}
                title={t.keys ? `${t.label} (${t.keys})` : t.label}
                onMouseDown={keepFocus}
                onClick={() => apply(t.edit)}
              >
                <Icon name={t.icon} size={16} />
              </button>
            ))}
          </span>
        ))}
        <span className="note-code-wrap">
          <button
            type="button"
            className={`btn note-code-btn${menu ? ' note-code-open' : ''}`}
            data-note-tool="code"
            aria-haspopup="menu"
            aria-expanded={menu}
            title="Insert a code block"
            onMouseDown={keepFocus}
            onClick={() => setMenu(!menu)}
          >
            <Icon name="code-block" size={16} />
            Code block
          </button>
          {menu && (
            <div className="menu-panel note-code-menu" role="menu" aria-label="Code block language">
              {CODE_LANGUAGES.map((l) => (
                <button
                  key={l.label}
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    setMenu(false)
                    apply((t, a, b) => codeBlock(t, a, b, l.name))
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="note-spacer" />
        <button type="button" className="btn btn-solid note-done" title="Save (Ctrl+Enter)" onMouseDown={keepFocus} onClick={save}>
          Done
        </button>
      </div>
      <textarea
        ref={box}
        className="note-input"
        aria-label="Note text, written in markdown"
        placeholder="Write in markdown, or use the buttons above."
        spellCheck
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (menu) setMenu(false)
            else onDone()
          } else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            save()
          } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault()
            apply((_, a, b) => indent(a, b))
          } else if (e.ctrlKey && !e.shiftKey && !e.altKey && KEYED[e.key.toLowerCase()]) {
            e.preventDefault()
            apply(KEYED[e.key.toLowerCase()].edit)
          }
        }}
      />
    </div>
  )
}

function ColorPicker({ node, color, onDone }: { node: StickyModel; color: string; onDone: () => void }): React.JSX.Element {
  return (
    <span className="note-colors nodrag" role="group" aria-label="Note color">
      {NOTE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${c === color ? ' swatch-on' : ''}`}
          style={{ background: c }}
          aria-label={`Use color ${c}`}
          aria-pressed={c === color}
          onClick={() => {
            if (c !== color) patchNode(node.id, { color: c })
            onDone()
          }}
        />
      ))}
    </span>
  )
}

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node as StickyModel
  const headerZoom = useHeaderZoom(node.id)
  const [editing, setEditing] = useState(false)
  const [picking, setPicking] = useState(false)
  const html = useMemo(() => noteMarkdown(node.text), [node.text])
  const tile = useMemo(() => noteTile(node.title, node.text), [node.title, node.text])
  const color = noteColor(node.color)
  // An agent's changes show until the person keeps or undoes them. Once the note changes some other way, they're past undoing.
  const edits = useStore((s) => s.noteEdits[node.id])
  const agentEdits = edits && edits.after === node.text ? edits : null
  const settle = (): void => {
    bridge.settleAgentEdits(node.id)
    useStore.setState((s) => {
      const { [node.id]: _settled, ...rest } = s.noteEdits
      return { noteEdits: rest }
    })
  }
  const editors = (ids: string[]): string => {
    const names = ids.map((id) => useStore.getState().doc?.nodes.find((n) => n.id === id)?.title ?? 'a closed agent')
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
  }

  const links = useLinkMenu(node.id)
  // The agents a cable joins it to, as one string, so the note redraws only when they change.
  const agentKey = useStore((s) => (s.doc ? linkedAgents(s.doc, node.id).map((a) => `${a.id}\t${a.title}`).join('\n') : ''))
  const agents = useMemo(() => (agentKey ? agentKey.split('\n').map((l) => ({ id: l.split('\t')[0], title: l.split('\t')[1] })) : []), [agentKey])
  const [sent, setSent] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(null), 6000)
    return () => clearTimeout(t)
  }, [sent])
  const send = async (): Promise<void> => {
    if (sending || !node.text.trim()) return
    setSending(true)
    const results: Array<{ title: string; result: SendResult }> = []
    try {
      for (const a of agents) {
        const result = await bridge.sendToAgent(a.id, node.text.trim()).catch((e: unknown): SendResult => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }))
        results.push({ title: a.title, result })
      }
    } finally {
      setSending(false)
      setSent(sendSummary(results))
    }
  }
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement
    const code = copiedCode(target)
    if (code !== null) {
      void navigator.clipboard.writeText(code).then(() => flashCopied(target))
      return
    }
    if (target instanceof HTMLInputElement && target.classList.contains('task')) {
      // The box only changes when the text does, so the note and its file can't disagree.
      e.preventDefault()
      const shown = e.currentTarget.querySelectorAll('input.task').length
      const next = toggleTask(node.text, Number(target.dataset.task), shown)
      if (next !== null) patchNode(node.id, { text: next })
      return
    }
    // Links must never navigate the app window. Web links go out through main, which checks them.
    const anchor = target.closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href')
    if (href) void bridge.openTerminalLink(node.id, href)
  }

  return (
    <div className={`note${selected ? ' note-selected' : ''}${editing ? ' note-editing' : ''}`} style={{ '--note': color } as React.CSSProperties}>
      <Resizer node={node} min={{ w: 220, h: 120 }} />
      <Jacks />
      <header className="note-head" onDoubleClick={headerZoom}>
        <EditableTitle node={node} />
        <span className="note-spacer" />
        {picking ? (
          <ColorPicker node={node} color={color} onDone={() => setPicking(false)} />
        ) : (
          <span className="note-head-tools">
            {agents.length > 0 && !editing && node.text.trim() && (
              <button type="button" className="icon-btn nodrag" aria-label={sendTitle(agents)} title={sendTitle(agents)} disabled={sending} data-note-send onClick={() => void send()}>
                <Icon name="arrow-right" size={15} />
              </button>
            )}
            <button type="button" className="icon-btn nodrag" aria-label="Note color" title="Color" onClick={() => setPicking(true)}>
              <Icon name="drop" size={15} />
            </button>
            {!editing && (
              <button type="button" className="icon-btn nodrag" aria-label="Edit note" title="Edit" onClick={() => setEditing(true)}>
                <Icon name="edit" size={15} />
              </button>
            )}
            <button type="button" className="icon-btn nodrag" aria-label="Delete note" title="Delete note" onClick={() => closeNodes([node.id])}>
              <Icon name="trash" size={15} />
            </button>
          </span>
        )}
      </header>
      {editing ? (
        <Editor node={node} onDone={() => setEditing(false)} />
      ) : node.text ? (
        <div
          className="note-body md nowheel"
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest('input, a, .code-copy')) setEditing(true)
          }}
          onClick={onBodyClick}
          onContextMenu={links.onContextMenu}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).classList.contains('code-copy')) {
              e.preventDefault()
              onBodyClick(e as unknown as React.MouseEvent<HTMLDivElement>)
            }
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <button type="button" className="note-body note-empty nodrag" onClick={() => setEditing(true)}>
          Write a note
        </button>
      )}
      {sent && !editing && (
        <footer className="note-edited note-sent nodrag" role="status">
          <span className="note-edited-text">{sent}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => setSent(null)}>
            <Icon name="close" size={15} />
          </button>
        </footer>
      )}
      {agentEdits && !editing && (
        <footer className="note-edited nodrag" role="status">
          <span className="note-edited-text">
            Changed by <strong>{editors(agentEdits.by)}</strong> {relativeTime(agentEdits.at, Date.now())}
          </span>
          <button type="button" className="btn note-edited-undo" title="Put back the text from before the agent's change" onClick={() => (patchNode(node.id, { text: agentEdits.before }), settle())}>
            Undo
          </button>
          <button type="button" className="icon-btn" aria-label="Keep the change" title="Keep the change" onClick={settle}>
            <Icon name="check" size={15} />
          </button>
        </footer>
      )}
      {/* Zoomed out, the note reads as a tile at its on-screen size (zoom.css). Hidden near. */}
      <div className="note-far" aria-hidden="true">
        <strong className="note-far-title">{tile.title}</strong>
        {tile.lines.map((l, i) => (
          <span key={i} className="note-far-line">
            {l}
          </span>
        ))}
      </div>
      {links.menu}
      {links.notice && (
        <p className="link-notice" role="status">
          {links.notice}
        </p>
      )}
    </div>
  )
})
