import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isSessionNode, type CanvasNode, type SessionNode } from '../../shared/model'
import { copyText } from '../clipboard'
import { Icon, type IconName } from '../icons'
import { ContextMenu } from '../Menu'
import type { Point } from '../menus'
import { FONT_SIZE, steppedFontSize, windowFontSize } from '../prefs'
import { nameWithAi, patchNode, refreshWindow, toggleMaximize, useStore } from '../store'
import { terminalActions } from '../terminalRegistry'
import { headerMenuEntries, useHeaderMenu } from './headerMenu'

function Tool({ icon, label, tool, disabled, busy, pressed, onClick }: { icon: IconName; label: string; tool: string; disabled?: boolean; busy?: boolean; pressed?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`icon-btn tool-btn nodrag tool-${tool}${busy ? ' tool-btn-busy' : ''}`} data-tool={tool} aria-label={label} aria-pressed={pressed} title={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={15} />
    </button>
  )
}

/**
 * ⋯: the tools used now and then, in one menu. It draws at screen size outside the canvas, so it reads the same at
 * any zoom and no neighbouring window covers it. Shift+F10 on the focused window opens it too.
 */
function MoreTool({ node }: { node: SessionNode }): React.JSX.Element {
  const open = useHeaderMenu((s) => s.open === node.id)
  const naming = useStore((s) => !!s.naming[node.id])
  const chat = useStore((s) => !!s.chatView[node.id])
  const global = useStore((s) => s.terminalFontSize)
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<Point | null>(null)
  /** A press on ⋯ while the menu is open closes it first; the click that follows mustn't open it again. */
  const closedAt = useRef(0)
  const close = useCallback(() => {
    closedAt.current = Date.now()
    if (useHeaderMenu.getState().open === node.id) useHeaderMenu.setState({ open: null })
  }, [node.id])
  useLayoutEffect(() => {
    if (!open) return setAt(null)
    const r = button.current?.getBoundingClientRect()
    setAt(r ? { x: r.right, y: r.bottom + 4 } : null)
  }, [open])

  const size = windowFontSize(node.fontSize, global)
  const entries = headerMenuEntries(
    { kind: node.kind, chat, naming, size, global, own: node.fontSize !== undefined, min: FONT_SIZE.min, max: FONT_SIZE.max, folder: node.kind === 'terminal' && node.sshHost ? '' : node.cwd },
    {
      refresh: () => refreshWindow(node.id),
      toggleChat: () => useStore.setState((s) => ({ chatView: { ...s.chatView, [node.id]: !chat } })),
      name: () => void nameWithAi(node.id),
      step: (by) => patchNode(node.id, { fontSize: steppedFontSize(node.fontSize, global, by) }),
      resetSize: () => patchNode(node.id, { fontSize: undefined }),
      copyFolder: () => void copyText(node.cwd)
    }
  )
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn tool-btn nodrag tool-more${naming ? ' tool-btn-busy' : ''}`}
        data-tool="more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={naming ? `More tools for ${node.title}. Asking Claude for a name…` : `More tools for ${node.title}`}
        title={naming ? 'More tools. Asking Claude for a name…' : 'More tools (Shift+F10)'}
        onClick={() => {
          if (Date.now() - closedAt.current < 300) return
          useHeaderMenu.setState({ open: open ? null : node.id })
        }}
      >
        <Icon name="more" size={15} />
      </button>
      {open && at && createPortal(<ContextMenu at={at} anchor="end" entries={entries} label={`${node.title} tools`} onClose={close} />, document.body)}
    </>
  )
}

/**
 * The tools at the right of a session window's header: Find and Maximize, which are used most, and ⋯ for the rest.
 * Close stays with the header, because it can ask first.
 */
export function WindowTools({ node }: { node: CanvasNode }): React.JSX.Element | null {
  const maximized = useStore((s) => s.maximized === node.id)
  if (!isSessionNode(node)) return null
  return (
    <span className="tools" role="toolbar" aria-label={`${node.title} tools`}>
      <Tool tool="find" icon="find" label="Find in this window (Ctrl+F)" onClick={() => terminalActions(node.id)?.find()} />
      {/* Maximized, the header draws it after Close instead. */}
      {!maximized && <MaximizeTool node={node} />}
      <MoreTool node={node} />
    </span>
  )
}

/** Maximize, or Restore when the window is maximized. */
export function MaximizeTool({ node }: { node: CanvasNode }): React.JSX.Element | null {
  const maximized = useStore((s) => s.maximized === node.id)
  if (!isSessionNode(node)) return null
  return <Tool tool="maximize" icon={maximized ? 'restore' : 'maximize'} pressed={maximized} label={maximized ? 'Restore (Esc when the terminal is not in use, or F11)' : 'Maximize (F11)'} onClick={() => toggleMaximize(node.id)} />
}
