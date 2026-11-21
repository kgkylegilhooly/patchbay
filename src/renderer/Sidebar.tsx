import { memo, useEffect, useState } from 'react'
import { isSessionNode, whereShown, type Project } from '../shared/model'
import { bridge } from './bridge'
import { Icon, KindIcon } from './icons'
import { ContextMenu } from './Menu'
import { PeekButton, peekFrom } from './NeedsYouLayer'
import { closedProjectMenu, type Commands, type Point } from './menus'
import { StatusMark } from './status/StatusMarks'
import { RunDot, RunLabel, StatusBadge, StatusDot } from './nodes/StatusBadge'
import { PortChips } from './PortChips'
import { FilesChip } from './FilesChip'
import type { Prefs } from './prefs'
import type { Session } from './sessionTree'
import { closedProjects, projectBadge, projectSections, recentlyClosed, relativeTime, rowShowsWhere, statusSections } from './sidebarView'
import { useStore } from './store'
import { contextLabel } from './usageView'
import { useAgentOff } from './agentChoice'
import { useAgentStop, useAgentStops } from './agentStops'

const TICK_MS = 20_000

/** Keeps relative times moving while they're on screen. */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function Badge({ project }: { project: Project | undefined }): React.JSX.Element | null {
  if (!project) return null
  const { letter, color } = projectBadge(project)
  return (
    <span className="project-badge" style={{ background: color }} title={project.name} role="img" aria-label={`Project ${project.name}`}>
      {letter}
    </span>
  )
}

function Row({ session, project, tab, now, onReveal }: { session: Session; project: Project | undefined; tab: 'project' | 'status'; now: number; onReveal: (id: string) => void }): React.JSX.Element {
  const status = useStore((s) => s.statuses[session.id] ?? (session.kind === 'claude' ? 'unknown' : null))
  const run = useStore((s) => s.runs[session.id])
  const unseen = useStore((s) => s.attention.includes(session.id)) && status !== 'needs-you'
  const context = contextLabel(useStore((s) => s.usage.nodes[session.id]))
  const at = useStore((s) => s.activity[session.id])
  const inStatus = tab === 'status'
  // Its section says Need attention, so the row says why.
  const stopped = !!useAgentStop(status === 'unknown' ? session.id : undefined)
  const peekable = inStatus && session.kind === 'claude'
  // Under its own project's heading the badge and the project's folder would only repeat the heading.
  const where = whereShown(session)
  const showWhere = rowShowsWhere(where, project, tab)
  return (
    <li>
      <button
        type="button"
        className={`session${inStatus ? '' : ' session-in-project'}`}
        data-session={session.id}
        title={where || 'Home folder'}
        onClick={() => onReveal(session.id)}
        onKeyDown={(e) => {
          // Space peeks, as in Claude's agent view. Enter still goes to the window.
          if (!peekable || e.key !== ' ' || e.ctrlKey || e.altKey || e.shiftKey) return
          e.preventDefault()
          peekFrom(session.id, e.currentTarget)
        }}
      >
        <span className="session-top">
          {session.kind === 'run' ? <RunDot run={run} /> : <StatusDot status={status} nodeId={session.id} />}
          {inStatus && <Badge project={project} />}
          <KindIcon kind={session.kind} agent={session.kind === 'claude' ? session.agent : undefined} />
          <span className="session-title">{session.title}</span>
          {unseen && <span className="session-unseen" role="img" aria-label="Not looked at yet" title="Finished while you were elsewhere" />}
          {context && (
            <span className={`session-context usage-${context.level}`} title={`${context.text}${context.detail ? `\n${context.detail}` : ''}`}>
              {context.text.replace(' context', '')}
            </span>
          )}
          {(!inStatus || stopped) && status && <StatusBadge status={status} nodeId={session.id} />}
          {session.kind === 'run' && <RunLabel run={run} />}
        </span>
        {showWhere && (
          <span className="session-where-row">
            <span className={inStatus ? 'session-project' : 'session-where'}>{inStatus ? (project?.name ?? '') : where || 'Home folder'}</span>
            {inStatus && at !== undefined && (
              <time className="session-time" dateTime={new Date(at).toISOString()} title="Last activity">
                {relativeTime(at, now)}
              </time>
            )}
          </span>
        )}
        <PortChips nodeId={session.id} />
        {session.kind === 'claude' && <FilesChip nodeId={session.id} />}
      </button>
      {peekable && <PeekButton id={session.id} title={session.title} />}
    </li>
  )
}

function SectionHead({ id, label, count, open, onToggle, help, badge, mark }: { id: string; label: string; count: number; open: boolean; onToggle: () => void; help?: string; badge?: Project; mark?: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="sidebar-section-head">
      <button type="button" className={`sidebar-section${count === 0 ? ' sidebar-section-empty' : ''}`} data-section={id} aria-expanded={open} title={help} onClick={onToggle}>
        <span className={`sidebar-chevron${open ? ' sidebar-chevron-open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
        <Badge project={badge} />
        {mark}
        <span className="session-title">{label}</span>
        <span className="sidebar-count">{count}</span>
      </button>
    </h3>
  )
}

function SidebarView({ commands, prefs, onPrefs, onClose }: { commands: Commands; prefs: Prefs; onPrefs: (patch: Partial<Prefs>) => void; onClose: () => void }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const statuses = useStore((s) => s.statuses)
  const stops = useAgentStops((s) => s.stops)
  const attention = useStore((s) => s.attention)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ at: Point; project: Project } | null>(null)
  const now = useNow()
  const agentOff = useAgentOff()
  if (!doc) return null

  const tab = prefs.sidebarTab
  const filtering = query.trim() !== ''
  const projects = new Map(doc.projects.map((p) => [p.id, p]))
  const isOpen = (id: string, standard = true): boolean => filtering || !(prefs.collapsed[id] ?? !standard)
  const toggle = (id: string, standard = true): void => onPrefs({ collapsed: { ...prefs.collapsed, [id]: isOpen(id, standard) } })
  const row = (s: Session): React.JSX.Element => <Row key={s.id} session={s} project={s.projectId ? projects.get(s.projectId) : undefined} tab={tab} now={now} onReveal={commands.revealNode} />

  const bySection = projectSections(doc, query)
  const byStatus = statusSections(doc, statuses, attention, query, stops)
  const total = bySection.reduce((sum, s) => sum + s.tree.total, 0)
  const closed = closedProjects(doc)
  const recent = recentlyClosed(doc, query)
  const none = filtering && (tab === 'project' ? bySection.length === 0 : byStatus.every((s) => s.sessions.length === 0)) && recent.length === 0

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <h2>
          Sessions <span className="sidebar-count">{total}</span>
        </h2>
        <span className="sidebar-tools">
          <button
            type="button"
            className={`icon-btn tool-btn${prefs.sidebarPinned ? ' tool-btn-on' : ''}`}
            data-sidebar="pin"
            aria-pressed={prefs.sidebarPinned}
            aria-label={prefs.sidebarPinned ? 'Unpin, so clicking the canvas hides this' : 'Pin, to keep this open'}
            title={prefs.sidebarPinned ? 'Pinned: stays open. Click to hide it when the canvas is clicked' : 'Hides when the canvas is clicked. Click to keep it open'}
            onClick={() => onPrefs({ sidebarPinned: !prefs.sidebarPinned })}
          >
            <Icon name={prefs.sidebarPinned ? 'pin' : 'pin-off'} size={15} />
          </button>
          <button type="button" className="icon-btn tool-btn" aria-label="Hide sessions" title="Hide sessions" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </span>
      </div>
      <div className="sidebar-tabs" role="tablist" aria-label="Show sessions by">
        {(['project', 'status'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} data-sidebar-tab={t} className={`sidebar-tab${tab === t ? ' sidebar-tab-on' : ''}`} onClick={() => onPrefs({ sidebarTab: t })}>
            {t === 'project' ? 'Project' : 'Status'}
          </button>
        ))}
      </div>
      <input className="sidebar-filter" aria-label="Filter sessions" placeholder="Filter sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="sidebar-list">
        {none && <p className="sidebar-empty">No sessions match that filter.</p>}
        {tab === 'project' &&
          bySection.map(({ project, tree, count }) => {
            const id = `project:${project.id}`
            return (
              <section key={project.id} data-project-section={project.id}>
                <SectionHead id={id} label={project.name} count={count} badge={project} open={isOpen(id)} onToggle={() => toggle(id)} help={project.folder || 'Home folder'} />
                {isOpen(id) && (
                  <div className="sidebar-body">
                    {tree.total === 0 && <p className="sidebar-empty">No sessions here. Right-click the canvas to open one.</p>}
                    {tree.groups.map(({ group, sessions }) => (
                      <section key={group.id}>
                        <h4 className="sidebar-group">
                          <span className="sidebar-swatch" style={{ background: group.color ?? 'var(--cable-link)' }} />
                          <span className="session-title">{group.title}</span>
                          <span className="sidebar-count">{sessions.length}</span>
                        </h4>
                        <ul>{sessions.map(row)}</ul>
                      </section>
                    ))}
                    {tree.ungrouped.length > 0 && (
                      <section>
                        {tree.groups.length > 0 && <h4 className="sidebar-group sidebar-group-plain">Not in a group</h4>}
                        <ul>{tree.ungrouped.map(row)}</ul>
                      </section>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        {tab === 'status' &&
          byStatus.map((section) => {
            const id = `status:${section.id}`
            return (
              <section key={section.id} data-status-section={section.id}>
                <SectionHead id={id} label={section.label} count={section.sessions.length} help={section.help} open={isOpen(id)} onToggle={() => toggle(id)} mark={section.tone ? <StatusMark look={{ tone: section.tone, label: section.label }} size={8} /> : <span className="session-unseen" aria-hidden="true" />} />
                {isOpen(id) && section.sessions.length > 0 && <ul className="sidebar-body">{section.sessions.map(row)}</ul>}
                {isOpen(id) && section.sessions.length === 0 && section.id === 'needs-you' && !filtering && <p className="sidebar-empty">All clear.</p>}
              </section>
            )
          })}
        {tab === 'project' && closed.length > 0 && (
          <section data-closed-projects>
            <SectionHead id="closed-projects" label="Recently closed projects" count={closed.length} open={isOpen('closed-projects')} onToggle={() => toggle('closed-projects')} help="Their sessions keep running. Click one to bring it back" />
            {isOpen('closed-projects') && (
              <ul className="sidebar-body">
                {closed.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="session closed-row"
                      data-closed-project={p.id}
                      title={`Reopen ${p.name}. Right-click to delete it`}
                      onClick={() => commands.reopenProject(p.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ at: { x: e.clientX, y: e.clientY }, project: p })
                      }}
                    >
                      <Badge project={p} />
                      <span className="session-title">{p.name}</span>
                      <span className="session-time">{relativeTime(p.closedAt ?? now, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {(recent.length > 0 || !filtering) && (
          <section data-recently-closed>
            <SectionHead id="recent" label="Closed conversations" count={recent.length} open={isOpen('recent', false)} onToggle={() => toggle('recent', false)} help="Claude conversations you closed. Click one to reopen it" />
            {isOpen('recent', false) && (
              <ul className="sidebar-body">
                {recent.length === 0 && <li className="sidebar-empty">Close a Claude or Codex session and its conversation appears here.</li>}
                {recent.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" className="session closed-row" data-closed-session={entry.id} title={agentOff(entry.agent) ?? `Reopen, in ${entry.cwd}`} disabled={!!agentOff(entry.agent)} onClick={() => void bridge.reopenClosed(entry.id)}>
                      <KindIcon kind="claude" agent={entry.agent} />
                      <span className="session-title">{entry.title}</span>
                      <time className="session-time" dateTime={new Date(entry.closedAt).toISOString()}>
                        {relativeTime(entry.closedAt, now)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      {menu && (
        <ContextMenu
          at={menu.at}
          label={menu.project.name}
          entries={closedProjectMenu(commands, menu.project.id, {
            sessionTitles: doc.nodes.filter((n) => n.projectId === menu.project.id && isSessionNode(n)).map((n) => n.title),
            items: doc.nodes.filter((n) => n.projectId === menu.project.id && !isSessionNode(n)).length
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  )
}

/** Drawn again only when what it's given changes, so moving things on the canvas leaves it alone. */
export const Sidebar = memo(SidebarView)
