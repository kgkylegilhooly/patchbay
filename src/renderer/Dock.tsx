import { useViewport } from '@xyflow/react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ClaudeIcon, CodexIcon, Icon, type IconName } from './icons'
import { MenuPanel } from './Menu'
import { addMenu, type Commands } from './menus'
import { useStore } from './store'
import { workingInProject } from './restartStopped'
import { useAgentChoice } from './agentChoice'
import { commandAllowed } from '../shared/agents'
import { toggleFoldedMap, useChromeLayout } from './safeArea'
import { menuLeftWithin, waitingForReview, workLabel, workMenu } from './workDock'
import { useTriggersPaused } from './triggersPaused'
import './safeArea.css'
import { keyOf, withKey } from './a11y/keyHints'
import { useKeyOverrides } from './a11y/useKeyOverrides'

function DockButton({
  cmd,
  label,
  icon,
  pressed,
  className,
  onClick
}: {
  cmd: string
  label: string
  icon: IconName
  pressed?: boolean
  className?: string
  onClick: () => void
}): React.JSX.Element {
  // The tooltip teaches the key, following any rebinding.
  const keys = useKeyOverrides()
  return (
    <button type="button" className={`dock-btn${className ? ` ${className}` : ''}`} data-cmd={cmd} aria-label={label} title={withKey(label, cmd, keys)} aria-keyshortcuts={keyOf(cmd, keys) ?? undefined} aria-pressed={pressed} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}

function DockView({
  commands,
  sidebar,
  groupLabel
}: {
  commands: Commands
  sidebar: boolean
  groupLabel: string
}): React.JSX.Element {
  const { zoom } = useViewport()
  const board = useStore((s) => s.boardOpen)
  const focus = useStore((s) => !!s.focus)
  const git = useStore((s) => s.gitOpen)
  const agents = useAgentChoice()
  const waiting = useStore((s) => waitingForReview(s.doc?.projects.find((p) => p.id === s.doc?.activeProjectId)?.tasks?.tasks))
  const triggersPaused = useTriggersPaused((s) => s.paused)
  const keys = useKeyOverrides()
  const foldMap = useChromeLayout((s) => s.foldMap)
  const mapOpen = useChromeLayout((s) => s.mapOpen)
  const [open, setOpen] = useState<'add' | 'work' | null>(null)
  const adding = open === 'add'
  const working = open === 'work'
  const ref = useRef<HTMLDivElement>(null)
  const workRef = useRef<HTMLButtonElement>(null)
  const workPanel = useRef<HTMLDivElement>(null)

  // The Work menu opens over its button, kept inside the window: at 1024 px the button is near the dock's right end.
  useLayoutEffect(() => {
    const panel = workPanel.current
    const dock = ref.current
    if (!working || !panel || !dock || !workRef.current) return
    const left = menuLeftWithin({ dockLeft: dock.getBoundingClientRect().left, button: workRef.current.offsetLeft, width: panel.getBoundingClientRect().width, windowWidth: window.innerWidth })
    panel.style.left = `${left}px`
  }, [working])

  useEffect(() => {
    if (!open) return
    const onPress = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null)
    }
    window.addEventListener('mousedown', onPress, true)
    return () => window.removeEventListener('mousedown', onPress, true)
  }, [open])

  const close = (): void => setOpen(null)
  return (
    <div className="dock" ref={ref} role="toolbar" aria-label="Canvas tools">
      {adding && <MenuPanel entries={addMenu(commands)} label="Add" onClose={close} style={{ position: 'absolute', left: 0, bottom: 'calc(100% + 8px)' }} />}
      {working && (
        <MenuPanel
          entries={workMenu(commands, { waiting, triggersPaused, working: workingInProject(useStore.getState().doc, useStore.getState().statuses).map((a) => ({ id: a.id, title: a.title })) })}
          label="Work"
          onClose={close}
          panelRef={workPanel}
          style={{ position: 'absolute', left: workRef.current?.offsetLeft ?? 0, bottom: 'calc(100% + 8px)' }}
        />
      )}
      <button
        type="button"
        className="dock-btn dock-add"
        data-cmd="add"
        aria-label="Add to the canvas"
        title="Add to the canvas"
        aria-expanded={adding}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => (o === 'add' ? null : 'add'))}
      >
        <Icon name="plus" />
      </button>
      {commandAllowed('new-claude', agents) && (
      <button type="button" className="dock-btn" data-cmd="new-claude" aria-label="New Claude Code" title={withKey('New Claude Code', 'new-claude', keys)} aria-keyshortcuts={keyOf('new-claude', keys) ?? undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => commands.newClaudeForm()}>
        <ClaudeIcon size={18} />
      </button>
      )}
      {commandAllowed('new-codex', agents) && (
      <button type="button" className="dock-btn" data-cmd="new-codex" aria-label="New Codex" title={withKey('New Codex', 'new-codex', keys)} aria-keyshortcuts={keyOf('new-codex', keys) ?? undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => commands.newCodexForm()}>
        <CodexIcon size={18} />
      </button>
      )}
      <span className="dock-sep" />
      <DockButton cmd="group" label={groupLabel} icon="group" onClick={() => commands.group()} />
      <DockButton cmd="fit-view" label="Fit view" icon="fit" onClick={commands.fitView} />
      <DockButton cmd="tidy" label="Tidy canvas" icon="tidy" onClick={() => commands.tidy()} />
      <DockButton cmd="toggle-sidebar" label="Sessions sidebar" icon="sidebar" pressed={sidebar} onClick={() => commands.togglePref('sidebar')} />
      <DockButton cmd="toggle-board" label="Board view" icon="board" pressed={board} onClick={commands.toggleBoard} />
      <DockButton cmd="toggle-focus" label="Focus view" icon="grid" pressed={focus} onClick={() => commands.toggleFocus()} />
      <DockButton cmd="toggle-git" label="Git panel" icon="branch" pressed={git} onClick={() => commands.toggleGit()} />
      <span className="dock-sep" />
      <button
        type="button"
        ref={workRef}
        className="dock-work"
        data-cmd="work"
        aria-label={workLabel(waiting, triggersPaused)}
        title={triggersPaused ? 'All triggers are paused: Work > Pause all triggers turns them back on' : 'Search, recipes and workflows, review, files and projects'}
        aria-haspopup="menu"
        aria-expanded={working}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => (o === 'work' ? null : 'work'))}
      >
        Work
        {waiting > 0 && <span className="dock-count" aria-hidden>{waiting}</span>}
        {/* F54 showed the pause only inside the menu, so a forgotten one stopped every trigger unseen. */}
        {triggersPaused && <span className="dock-paused" aria-hidden data-triggers-paused>Paused</span>}
      </button>
      <span className="dock-sep" />
      {foldMap && <DockButton cmd="toggle-map" className="dock-map" label="Map of the canvas" icon="map" pressed={mapOpen} onClick={toggleFoldedMap} />}
      <DockButton cmd="zoom-out" label="Zoom out" icon="minus" onClick={commands.zoomOut} />
      <button type="button" className="dock-zoom" data-cmd="zoom-reset" title={withKey('Actual size', 'zoom-reset', keys)} aria-keyshortcuts={keyOf('zoom-reset', keys) ?? undefined} onMouseDown={(e) => e.preventDefault()} onClick={commands.zoomReset}>
        {Math.round(zoom * 100)}%
      </button>
      <DockButton cmd="zoom-in" label="Zoom in" icon="plus" onClick={commands.zoomIn} />
    </div>
  )
}

/** Drawn again only when what it's given changes, so moving things on the canvas leaves it alone. */
export const Dock = memo(DockView)
