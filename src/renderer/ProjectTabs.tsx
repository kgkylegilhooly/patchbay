import { useState } from 'react'
import { isProjectOpen, isSessionNode, type Project } from '../shared/model'
import { ContextMenu } from './Menu'
import { projectMenu, type Commands, type Point } from './menus'
import { projectSignal } from './projectSignal'
import { useStore } from './store'

const SIGNAL_TEXT = { 'needs-you': 'needs you', unseen: 'something to look at', working: 'working' }

function Tab({ project, active, commands, onMenu }: { project: Project; active: boolean; commands: Commands; onMenu: (at: Point, rename: () => void) => void }): React.JSX.Element {
  const signal = useStore((s) => (s.doc ? projectSignal(s.doc, s.statuses, project.id, s.attention) : null))
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
      className={`project-tab${active ? ' project-tab-active' : ''}`}
      title={project.folder || 'Home folder'}
      onClick={() => !active && commands.switchProject(project.id)}
      onDoubleClick={rename}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu({ x: e.clientX, y: e.clientY }, rename)
      }}
    >
      {signal && <span className={`project-signal project-signal-${signal}`} role="img" aria-label={SIGNAL_TEXT[signal]} />}
      <span className="project-name">{project.name}</span>
    </button>
  )
}

export function ProjectTabs({ commands }: { commands: Commands }): React.JSX.Element | null {
  const projects = useStore((s) => s.doc?.projects)
  const activeId = useStore((s) => s.doc?.activeProjectId)
  const [menu, setMenu] = useState<{ at: Point; project: Project; rename: () => void } | null>(null)
  if (!projects) return null

  const inProject = (id: string) => useStore.getState().doc?.nodes.filter((n) => n.projectId === id) ?? []
  const open = projects.filter(isProjectOpen)

  return (
    <div className="projects" role="tablist" aria-label="Projects">
      {open.map((p) => (
        <Tab key={p.id} project={p} active={p.id === activeId} commands={commands} onMenu={(at, rename) => setMenu({ at, project: p, rename })} />
      ))}
      <button type="button" className="project-add" data-cmd="new-project" aria-label="New project" title="New project" onMouseDown={(e) => e.preventDefault()} onClick={commands.newProject}>
        +
      </button>
      {menu && (
        <ContextMenu
          at={menu.at}
          label={menu.project.name}
          entries={projectMenu(commands, menu.project.id, {
            sessionTitles: inProject(menu.project.id).filter(isSessionNode).map((n) => n.title),
            items: inProject(menu.project.id).filter((n) => !isSessionNode(n)).length,
            canClose: open.length > 1,
            last: projects.length === 1,
            rename: menu.rename
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
