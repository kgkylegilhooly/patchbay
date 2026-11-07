import { useEffect, useRef, useState } from 'react'
import { isSessionNode, type CanvasNode } from '../../shared/model'
import { Icon, type IconName } from '../icons'
import { FONT_SIZE, steppedFontSize, windowFontSize } from '../prefs'
import { nameWithAi, patchNode, refreshWindow, toggleMaximize, useStore } from '../store'
import { terminalActions } from '../terminalRegistry'

function Tool({ icon, label, tool, disabled, busy, pressed, onClick }: { icon: IconName; label: string; tool: string; disabled?: boolean; busy?: boolean; pressed?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`icon-btn tool-btn nodrag tool-${tool}${busy ? ' tool-btn-busy' : ''}`} data-tool={tool} aria-label={label} aria-pressed={pressed} title={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={15} />
    </button>
  )
}

/** Smaller, the current size (click for the global size), and larger. */
function FontSteps({ node }: { node: CanvasNode }): React.JSX.Element {
  const global = useStore((s) => s.terminalFontSize)
  const size = windowFontSize(node.fontSize, global)
  const own = node.fontSize !== undefined
  const step = (by: number): void => patchNode(node.id, { fontSize: steppedFontSize(node.fontSize, global, by) })
  return (
    <>
      <button type="button" className="icon-btn tool-btn font-step nodrag" data-tool="font-smaller" aria-label="Smaller text in this window" title="Smaller text in this window" disabled={size <= FONT_SIZE.min} onClick={() => step(-1)}>
        <Icon name="minus" size={13} />
      </button>
      <button
        type="button"
        className={`font-size nodrag${own ? ' font-size-own' : ''}`}
        data-tool="font-reset"
        aria-label={own ? `Text size ${size} in this window. Back to the global size, ${global}` : `Text size ${size}, the global size`}
        title={own ? `Size ${size} in this window. Click for the global size, ${global}` : `Size ${size}, from the global setting`}
        disabled={!own}
        onClick={() => patchNode(node.id, { fontSize: undefined })}
      >
        {size}
      </button>
      <button type="button" className="icon-btn tool-btn font-step nodrag" data-tool="font-larger" aria-label="Larger text in this window" title="Larger text in this window" disabled={size >= FONT_SIZE.max} onClick={() => step(1)}>
        <Icon name="plus" size={13} />
      </button>
    </>
  )
}

/** Inline where there's room. On a narrow window they fold into one button that opens them. */
function FontTools({ node }: { node: CanvasNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onPress = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onPress, true)
    return () => window.removeEventListener('mousedown', onPress, true)
  }, [open])
  return (
    <span className="font-tools" ref={ref} role="group" aria-label="Text size in this window">
      <span className="font-inline">
        <FontSteps node={node} />
      </span>
      <button type="button" className="icon-btn tool-btn font-fold nodrag" data-tool="font-fold" aria-label="Text size in this window" aria-expanded={open} title="Text size in this window" onClick={() => setOpen((o) => !o)}>
        <Icon name="text-size" size={15} />
      </button>
      {open && (
        <span className="font-pop nodrag">
          <FontSteps node={node} />
        </span>
      )}
    </span>
  )
}

/** The icon buttons at the right of a session window's header. Close stays with the header, because it can ask first. */
export function WindowTools({ node }: { node: CanvasNode }): React.JSX.Element | null {
  const maximized = useStore((s) => s.maximized === node.id)
  const naming = useStore((s) => !!s.naming[node.id])
  const chat = useStore((s) => !!s.chatView[node.id])
  if (!isSessionNode(node)) return null
  const nameable = node.kind === 'terminal' || node.kind === 'claude'
  return (
    <span className="tools" role="toolbar" aria-label={`${node.title} tools`}>
      <Tool tool="refresh" icon="refresh" label="Refresh the view. The session keeps running" onClick={() => refreshWindow(node.id)} />
      {node.kind === 'claude' && (
        <Tool tool="chat" icon={chat ? 'terminal' : 'note'} pressed={chat} label={chat ? 'Show the terminal' : 'Show as a chat'} onClick={() => useStore.setState((s) => ({ chatView: { ...s.chatView, [node.id]: !chat } }))} />
      )}
      <Tool tool="find" icon="find" label="Find in this window" onClick={() => terminalActions(node.id)?.find()} />
      {nameable && <Tool tool="name" icon="sparkle" busy={naming} disabled={naming} label={naming ? 'Asking Claude for a name…' : 'Name with AI, from recent output. Uses a little plan quota'} onClick={() => void nameWithAi(node.id)} />}
      <FontTools node={node} />
      <Tool tool="maximize" icon={maximized ? 'restore' : 'maximize'} pressed={maximized} label={maximized ? 'Restore (Esc when the terminal is not in use, or F11)' : 'Maximize'} onClick={() => toggleMaximize(node.id)} />
    </span>
  )
}
