import { useEffect, useRef, useState } from 'react'
import { archiveRefusal, removeRefusal } from '../core/canvas/projectOps'
import { isProjectOpen, isSessionNode, type Project } from '../shared/model'
import { ContextMenu } from './Menu'
import { projectMenu, type Commands, type Point } from './menus'
import { moveProjectTab } from './projectActions'
import { dropTarget, type TabDrop } from './projectTabDrag'
import { projectSignal, SIGNAL_TONE } from './projectSignal'
import { useAgentStops } from './agentStops'
import { StatusMark } from './status/StatusMarks'
import { useStore } from './store'

const SIGNAL_TEXT = {
  'needs-you': 'needs you',
  stopped: 'an agent stopped',
  unseen: 'something to look at',
  working: 'working'
}
const DRAG_TYPE = 'application/x-patchbay-project'

interface TabProps {
  project: Project
  active: boolean
  commands: Commands
  /** A drop here would land the dragged tab just before this one. */
  dropBefore: boolean
  dragging: boolean
  onMenu: (at: Point, rename: () => void) => void
  onDragStart: () => void
  onDragEnd: () => void
}

function Tab({ project, active, commands, dropBefore, dragging, onMenu, onDragStart, onDragEnd }: TabProps): React.JSX.Element {
  const stops = useAgentStops((s) => s.stops)
  const signal = useStore((s) => (s.doc ? projectSignal(s.doc, s.statuses, project.id, s.attention, stops, s.runs) : null))
  const [draft, setDraft] = useState<string | null>(null)

  if (draft !== null) {
    const save = (): void => {
      const name = draft.trim()
      if (name && name !== project.name) commands.setProjectName(project.id, name)
      setDraft(null)
    }
    return (
      <input
        className="project-rename"
        aria-label="Project name"
        autoFocus
        value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setDraft(null)
        }}
      />
    )
  }

  const rename = (): void => setDraft(project.name)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-project-id={project.id}
      className={`project-tab${active ? ' project-tab-active' : ''}${dropBefore ? ' project-tab-drop' : ''}${dragging ? ' project-tab-dragging' : ''}`}
      title={`${project.folder || 'Home folder'}\nDrag, or Alt+Shift+Left/Right, to move this tab.`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, project.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={() => !active && commands.switchProject(project.id)}
      onDoubleClick={rename}
      onContextMenu={(e) => {
        e.preventDefault()
        // Below the tab, from its left edge, so the menu never covers the tab it's for (or the keyboard's menu key).
        const tab = e.currentTarget.getBoundingClientRect()
        onMenu({ x: Math.round(tab.left), y: Math.round(tab.bottom) + 4 }, rename)
      }}
    >
      {signal && (SIGNAL_TONE[signal] ? (
        <span className={`project-signal project-signal-${signal}`} role="img" aria-label={SIGNAL_TEXT[signal]}>
          <StatusMark look={{ tone: SIGNAL_TONE[signal]!, label: SIGNAL_TEXT[signal] }} size={8} />
        </span>
      ) : (
        <span className={`project-signal project-signal-${signal}`} role="img" aria-label={SIGNAL_TEXT[signal]} />
      ))}
      <span className="project-name">{project.name}</span>
    </button>
  )
}

export function ProjectTabs({ commands }: { commands: Commands }): React.JSX.Element | null {
  const projects = useStore((s) => s.doc?.projects)
  const activeId = useStore((s) => s.doc?.activeProjectId)
  const [menu, setMenu] = useState<{
    at: Point
    project: Project
    rename: () => void
  } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<TabDrop | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** A tab moved from the keyboard keeps the keyboard, even though React moved it in the page. */
  const refocus = useRef<string | null>(null)

  useEffect(() => {
    if (!refocus.current) return
    listRef.current?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(refocus.current)}"]`)?.focus()
    refocus.current = null
  })

  if (!projects) return null

  const inProject = (id: string) => useStore.getState().doc?.nodes.filter((n) => n.projectId === id) ?? []
  const open = projects.filter(isProjectOpen)
  const indexOf = (id: string): number => open.findIndex((p) => p.id === id)

  const endDrag = (): void => {
    setDragId(null)
    setDrop(null)
  }

  /** Where the dragged tab would land, from the pointer and where each open tab is drawn. */
  const over = (e: React.DragEvent): void => {
    if (!dragId || !listRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const tabs = [...listRef.current.querySelectorAll<HTMLElement>('[data-project-id]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.projectId!, mid: r.left + r.width / 2 }
    })
    const next = dropTarget(tabs, dragId, e.clientX)
    if (next?.before !== drop?.before || !!next !== !!drop) setDrop(next)
  }

  const keys = (e: React.KeyboardEvent): void => {
    const id = (e.target as HTMLElement).dataset?.projectId
    if (!id) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const step = e.key === 'ArrowLeft' ? -1 : 1
    e.preventDefault()
    e.stopPropagation()
    if (e.altKey && e.shiftKey) {
      refocus.current = id
      commands.moveProjectTab(step, id)
      return
    }
    // Arrow keys walk the tabs, as in any tab list.
    const to = open[indexOf(id) + step]
    if (to) listRef.current?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(to.id)}"]`)?.focus()
  }

  return (
    <div
      className="projects"
      role="tablist"
      aria-label="Projects"
      ref={listRef}
      onKeyDown={keys}
      onDragOver={over}
      onDragLeave={(e) => {
        if (!listRef.current?.contains(e.relatedTarget as Node)) setDrop(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const id = e.dataTransfer.getData(DRAG_TYPE) || dragId
        if (id && drop) moveProjectTab(id, drop.before)
        endDrag()
      }}
    >
      {open.map((p) => (
        <Tab
          key={p.id}
          project={p}
          active={p.id === activeId}
          commands={commands}
          dropBefore={!!drop && drop.before === p.id}
          dragging={dragId === p.id}
          onMenu={(at, rename) => setMenu({ at, project: p, rename })}
          onDragStart={() => setDragId(p.id)}
          onDragEnd={endDrag}
        />
      ))}
      <button
        type="button"
        className={`project-add${drop && drop.before === null ? ' project-tab-drop' : ''}`}
        data-cmd="new-project"
        aria-label="New project"
        title="New project"
        onMouseDown={(e) => e.preventDefault()}
        onClick={commands.newProject}
      >
        +
      </button>
      {menu && (
        <ContextMenu
          at={menu.at}
          label={menu.project.name}
          entries={projectMenu(commands, menu.project.id, {
            sessionTitles: inProject(menu.project.id)
              .filter(isSessionNode)
              .map((n) => n.title),
            items: inProject(menu.project.id).filter((n) => !isSessionNode(n)).length,
            canClose: open.length > 1,
            last: !!removeRefusal({ projects }, menu.project.id),
            rename: menu.rename,
            canMoveLeft: indexOf(menu.project.id) > 0,
            canMoveRight: indexOf(menu.project.id) < open.length - 1,
            archiveRefusal: archiveRefusal({ projects }, menu.project.id),
            name: menu.project.name
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
