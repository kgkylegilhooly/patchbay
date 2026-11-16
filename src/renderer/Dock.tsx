import { useViewport } from '@xyflow/react'
import { memo, useEffect, useRef, useState } from 'react'
import { ClaudeIcon, CodexIcon, Icon, type IconName } from './icons'
import { MenuPanel } from './Menu'
import { addMenu, type Commands } from './menus'
import { useStore } from './store'

function DockButton({
  cmd,
  label,
  icon,
  pressed,
  onClick
}: {
  cmd: string
  label: string
  icon: IconName
  pressed?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="dock-btn" data-cmd={cmd} aria-label={label} title={label} aria-pressed={pressed} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}

function DockView({
  commands,
  sidebar,
  recent,
  groupLabel
}: {
  commands: Commands
  sidebar: boolean
  recent: boolean
  groupLabel: string
}): React.JSX.Element {
  const { zoom } = useViewport()
  const board = useStore((s) => s.boardOpen)
  const focus = useStore((s) => !!s.focus)
  const git = useStore((s) => s.gitOpen)
  const [adding, setAdding] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!adding) return
    const onPress = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setAdding(false)
    }
    window.addEventListener('mousedown', onPress, true)
    return () => window.removeEventListener('mousedown', onPress, true)
  }, [adding])

  return (
    <div className="dock" ref={ref} role="toolbar" aria-label="Canvas tools">
      {adding && <MenuPanel entries={addMenu(commands)} label="Add" onClose={() => setAdding(false)} style={{ position: 'absolute', left: 0, bottom: 'calc(100% + 8px)' }} />}
      <button
        type="button"
        className="dock-btn dock-add"
        data-cmd="add"
        aria-label="Add to the canvas"
        title="Add to the canvas"
        aria-expanded={adding}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setAdding((a) => !a)}
      >
        <Icon name="plus" />
      </button>
      <button type="button" className="dock-btn" data-cmd="new-claude" aria-label="New Claude Code" title="New Claude Code" onMouseDown={(e) => e.preventDefault()} onClick={() => commands.newClaudeForm()}>
        <ClaudeIcon size={18} />
      </button>
      <button type="button" className="dock-btn" data-cmd="new-codex" aria-label="New Codex" title="New Codex" onMouseDown={(e) => e.preventDefault()} onClick={() => commands.newCodexForm()}>
        <CodexIcon size={18} />
      </button>
      <span className="dock-sep" />
      <DockButton cmd="group" label={groupLabel} icon="group" onClick={() => commands.group()} />
      <DockButton cmd="fit-view" label="Fit view" icon="fit" onClick={commands.fitView} />
      <DockButton cmd="tidy" label="Tidy canvas" icon="tidy" onClick={() => commands.tidy()} />
      <DockButton cmd="toggle-sidebar" label="Sessions sidebar" icon="sidebar" pressed={sidebar} onClick={() => commands.togglePref('sidebar')} />
      <DockButton cmd="recent" label="Recent conversations" icon="recent" pressed={recent} onClick={commands.toggleRecent} />
      <DockButton cmd="toggle-board" label="Board view" icon="board" pressed={board} onClick={commands.toggleBoard} />
      <DockButton cmd="toggle-focus" label="Focus view" icon="grid" pressed={focus} onClick={() => commands.toggleFocus()} />
      <DockButton cmd="toggle-git" label="Git panel" icon="branch" pressed={git} onClick={() => commands.toggleGit()} />
      <span className="dock-sep" />
      <DockButton cmd="zoom-out" label="Zoom out" icon="minus" onClick={commands.zoomOut} />
      <button type="button" className="dock-zoom" data-cmd="zoom-reset" title="Actual size" onMouseDown={(e) => e.preventDefault()} onClick={commands.zoomReset}>
        {Math.round(zoom * 100)}%
      </button>
      <DockButton cmd="zoom-in" label="Zoom in" icon="plus" onClick={commands.zoomIn} />
    </div>
  )
}

/** Drawn again only when what it's given changes, so moving things on the canvas leaves it alone. */
export const Dock = memo(DockView)
