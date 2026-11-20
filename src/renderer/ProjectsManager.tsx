import { useCallback, useEffect, useMemo, useState } from 'react'
import { archiveRefusal, removeRefusal } from '../core/canvas/projectOps'
import { isSessionNode } from '../shared/model'
import { formatBytes, type StorageReport } from '../shared/projects'
import type { Commands } from './menus'
import { deleteProjectWarning } from './menus'
import { projectsBridge } from './projectsBridge'
import { unarchiveProject } from './projectActions'
import { askArchive, readSuggestDays, saveSuggestDays, SUGGEST_CHOICES, useProjectsUi } from './projectsUi'
import { daysAgo, projectRows, sortRows, type ProjectRow, type SortKey } from './projectsView'
import { projectBadge } from './sidebarView'
import { shortPath } from './shortPath'
import { Icon } from './icons'
import { useStore } from './store'

const COLUMNS: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: 'name', label: 'Project' },
  { key: 'state', label: 'State' },
  { key: 'nodes', label: 'Nodes', numeric: true },
  { key: 'sessions', label: 'Sessions', numeric: true },
  { key: 'lastActive', label: 'Last active' },
  { key: 'storage', label: 'Saved output', numeric: true }
]

const STATE_TEXT = { open: 'Open', closed: 'Closed', archived: 'Archived' }

function Row({
  row,
  commands,
  now,
  refusals
}: {
  row: ProjectRow
  commands: Commands
  now: number
  refusals: { archive: string | null; remove: string | null; close: boolean }
}): React.JSX.Element {
  const { project, state, active } = row
  const [draft, setDraft] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const badge = projectBadge(project)
  const inside = useStore.getState().doc?.nodes.filter((n) => n.projectId === project.id) ?? []

  const save = (): void => {
    const name = draft?.trim()
    if (name && name !== project.name) commands.setProjectName(project.id, name)
    setDraft(null)
  }

  return (
    <tr className={`projects-row projects-row-${state}${active ? ' projects-row-active' : ''}`} data-project={project.id}>
      <td>
        <div className="projects-name-cell">
          <span className="project-badge" style={{ background: badge.color }} role="img" aria-label={`Project ${project.name}`}>
            {badge.letter}
          </span>
          <span className="projects-name-block">
            {draft !== null ? (
              <input
                className="projects-rename"
                aria-label="Project name"
                autoFocus
                value={draft}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setDraft(null)
                  }
                }}
              />
            ) : (
              <span className="projects-name">{project.name}</span>
            )}
            <span className="projects-folder" title={project.folder || 'Home folder'}>
              {project.folder ? shortPath(project.folder) : 'Home folder'}
            </span>
          </span>
        </div>
      </td>
      <td>
        <span className={`projects-state projects-state-${state}`}>{active ? 'On screen' : STATE_TEXT[state]}</span>
        {row.unusedDays !== null && (
          <span className="projects-unused" title="Unused for longer than your setting. Archiving is up to you.">
            Unused {row.unusedDays} days
          </span>
        )}
      </td>
      <td className="projects-num">{row.nodes}</td>
      <td className="projects-num">
        {row.sessions}
        {row.running ? <span className="projects-running"> · {row.running} running</span> : null}
      </td>
      <td className="projects-when" title={row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleString() : 'No sign of use found'}>{active ? 'now' : daysAgo(row.lastActiveAt, now)}</td>
      <td className="projects-num">{row.scrollbackBytes === null ? '…' : formatBytes(row.scrollbackBytes)}</td>
      <td>
        <div className="projects-actions">
          {state === 'archived' ? (
            <>
              <button type="button" className="btn compare-small" onClick={() => unarchiveProject(project.id)}>
                Unarchive
              </button>
              <button
                type="button"
                className="btn compare-small"
                onClick={() => {
                  unarchiveProject(project.id)
                  commands.reopenProject(project.id)
                }}
              >
                Unarchive and open
              </button>
            </>
          ) : (
            <>
              {!active && (
                <button
                  type="button"
                  className="btn compare-small"
                  onClick={() => (state === 'closed' ? commands.reopenProject(project.id) : commands.switchProject(project.id))}
                >
                  Open
                </button>
              )}
              {state === 'open' && (
                <button
                  type="button"
                  className="btn compare-small"
                  onClick={() => commands.closeProject(project.id)}
                  disabled={!refusals.close}
                  title={refusals.close ? 'Takes it off the tabs. Its sessions keep running.' : 'The last open project stays open.'}
                >
                  Close project
                </button>
              )}
              <button
                type="button"
                className={`btn compare-small${row.unusedDays !== null ? ' projects-suggested' : ''}`}
                disabled={!!refusals.archive}
                title={refusals.archive ?? 'Stops its sessions and puts it away. Asks first.'}
                onClick={() => askArchive(project.id)}
              >
                Archive…
              </button>
            </>
          )}
          <button type="button" className="btn compare-small" onClick={() => setDraft(project.name)}>
            Rename
          </button>
          <button
            type="button"
            className={`btn compare-small${confirmDelete ? ' btn-danger' : ' projects-delete'}`}
            disabled={!!refusals.remove}
            title={
              confirmDelete
                ? deleteProjectWarning(
                    inside.filter(isSessionNode).map((n) => n.title),
                    inside.filter((n) => !isSessionNode(n)).length
                  )
                : (refusals.remove ?? 'Removes it and everything in it, for good. Asks first.')
            }
            onBlur={() => setConfirmDelete(false)}
            onClick={() => (confirmDelete ? commands.deleteProject(project.id) : setConfirmDelete(true))}
          >
            {confirmDelete ? 'Delete for good?' : 'Delete…'}
          </button>
        </div>
      </td>
    </tr>
  )
}

/** Every project, open, closed and archived, with what it holds and when it was last used. */
export function ProjectsManager({ commands, onClose }: { commands: Commands; onClose: () => void }): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const archiving = useProjectsUi((s) => s.archive)
  const notice = useProjectsUi((s) => s.notice)
  const [report, setReport] = useState<StorageReport | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'order',
    descending: false
  })
  const [suggestDays, setSuggestDays] = useState(readSuggestDays)
  const [cacheNote, setCacheNote] = useState<string | null>(null)
  const [now] = useState(Date.now)

  const measure = useCallback(() => void projectsBridge.storage().then((r) => r && 'projects' in r && setReport(r)), [])
  const projectIds = doc?.projects.map((p) => `${p.id}:${p.closedAt ?? ''}:${p.archivedAt ?? ''}`).join() ?? ''
  // Measured again when a project is archived, unarchived or removed, and when the archive dialog closes.
  useEffect(measure, [measure, projectIds, archiving])

  const rows = useMemo(
    () => (doc ? sortRows(projectRows(doc, report?.projects ?? null, suggestDays, now), sort.key, sort.descending) : []),
    [doc, report, suggestDays, now, sort]
  )
  if (!doc) return null

  const counts = {
    open: rows.filter((r) => r.state === 'open').length,
    closed: rows.filter((r) => r.state === 'closed').length,
    archived: rows.filter((r) => r.state === 'archived').length
  }
  const by = (key: SortKey): void =>
    setSort((s) =>
      s.key === key
        ? { key, descending: !s.descending }
        : {
            key,
            descending: key === 'lastActive' || key === 'storage' || key === 'nodes' || key === 'sessions'
          }
    )
  const browser = report?.browser

  return (
    <div
      className="pop projects-sheet"
      role="dialog"
      aria-label="Projects"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !archiving) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="projects-head">
        <h2>Projects</h2>
        <p className="compare-dim">
          {counts.open} open · {counts.closed} closed · {counts.archived} archived
        </p>
        <button type="button" className="icon-btn projects-close" aria-label="Close projects" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      {notice && (
        <p className="projects-notice" role="status">
          {notice}
        </p>
      )}
      {/* Focus starts on the table, so Enter or a stray key never closes the manager by surprise. */}
      <div className="projects-table-wrap" role="region" aria-label="All projects" tabIndex={0} autoFocus>
        <table className="projects-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.numeric ? 'projects-num' : undefined}
                  aria-sort={sort.key === c.key ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                >
                  <button type="button" className="projects-sort" onClick={() => by(c.key)}>
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true">{sort.descending ? ' ▾' : ' ▴'}</span>}
                  </button>
                </th>
              ))}
              <th>
                <button type="button" className="projects-sort" onClick={() => setSort({ key: 'order', descending: false })} title="Back to tab order">
                  Actions
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row
                key={row.project.id}
                row={row}
                commands={commands}
                now={now}
                refusals={{
                  archive: archiveRefusal(doc, row.project.id),
                  remove: removeRefusal(doc, row.project.id),
                  close: counts.open > 1
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="projects-foot">
        <p className="compare-dim projects-storage">
          {browser ? (
            <>
              Browser data is shared by every project: {formatBytes(browser.personBytes + browser.agentBytes)}, of which {formatBytes(browser.cacheBytes)} is
              cache that pages fill again as needed. Agents' conversations are kept by Claude Code and Codex, outside Patchbay.
            </>
          ) : (
            'Measuring…'
          )}
          {cacheNote && <span className="projects-note"> {cacheNote}</span>}
        </p>
        <button
          type="button"
          className="btn compare-small"
          disabled={!browser || browser.cacheBytes === 0}
          title="Clears the browser cache of every project's pages. Sign-ins and site data stay."
          onClick={() =>
            void projectsBridge.clearBrowserCache().then((r) => {
              setCacheNote(r.ok ? `Cleared ${formatBytes(r.freedBytes)}.` : r.reason)
              measure()
            })
          }
        >
          Clear browser cache
        </button>
        <label className="projects-suggest">
          Suggest archiving after
          <select
            value={suggestDays}
            onChange={(e) => {
              const days = Number(e.target.value)
              setSuggestDays(days)
              saveSuggestDays(days)
            }}
          >
            {SUGGEST_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d === 0 ? 'Off' : `${d} days unused`}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
