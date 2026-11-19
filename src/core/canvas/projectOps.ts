import { isProjectArchived, isProjectOpen, type CanvasDoc, type Project } from '../../shared/model'

/**
 * Tab order and archiving. Pure, shared by the reducer, main (which checks before stopping anything) and the page
 * (which disables what would be refused, and says why).
 */

/** The same projects in the order given. Any the order doesn't name keep their place after the ones it does. */
export function orderProjects(projects: Project[], order: string[]): Project[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const sorted = projects
    .map((p, i) => ({ p, key: rank.get(p.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.p)
  return sorted.every((p, i) => p === projects[i]) ? projects : sorted
}

/** Moves one project to just before another, or to the end. The same array when nothing would change. */
export function moveProjectBefore(projects: Project[], id: string, before: string | null): Project[] {
  const moving = projects.find((p) => p.id === id)
  if (!moving || before === id) return projects
  if (before !== null && !projects.some((p) => p.id === before)) return projects
  const rest = projects.filter((p) => p.id !== id)
  const at = before === null ? rest.length : rest.findIndex((p) => p.id === before)
  const next = [...rest.slice(0, at), moving, ...rest.slice(at)]
  return next.every((p, i) => p === projects[i]) ? projects : next
}

/**
 * The project whose tab sits `step` places along from this one, among the open tabs, for Move left and Move right.
 * What to pass as `before` to get there, or undefined when it's already at that end.
 */
export function tabStep(projects: Project[], id: string, step: -1 | 1): { before: string | null } | undefined {
  const open = projects.filter(isProjectOpen)
  const index = open.findIndex((p) => p.id === id)
  if (index === -1) return undefined
  const target = index + step
  if (target < 0 || target >= open.length) return undefined
  // Moving right lands it before the tab after its neighbour, or at the very end.
  if (step === 1) return { before: open[target + 1]?.id ?? null }
  return { before: open[target].id }
}

/** Projects that aren't archived, other than this one. Something must always be left to show. */
const othersLeft = (doc: Pick<CanvasDoc, 'projects'>, id: string): number => doc.projects.filter((p) => p.id !== id && !isProjectArchived(p)).length

/** Why this project can't be archived now, or null if it can. */
export function archiveRefusal(doc: Pick<CanvasDoc, 'projects'>, id: string): string | null {
  const project = doc.projects.find((p) => p.id === id)
  if (!project) return 'There is no such project.'
  if (isProjectArchived(project)) return 'This project is already archived.'
  if (othersLeft(doc, id) === 0) return "It's the only project that isn't archived. Create or unarchive another one first."
  return null
}

/** Why this project can't be deleted now, or null if it can. */
export function removeRefusal(doc: Pick<CanvasDoc, 'projects'>, id: string): string | null {
  if (!doc.projects.some((p) => p.id === id)) return 'There is no such project.'
  if (doc.projects.length === 1) return "It's the only project."
  if (othersLeft(doc, id) === 0) return "It's the only project that isn't archived. Create or unarchive another one first."
  return null
}

/** The nearest project that isn't archived, looking right first, as a closed tab's stand-in on screen. */
export function nearestUnarchived(doc: Pick<CanvasDoc, 'projects'>, id: string): Project | undefined {
  const index = doc.projects.findIndex((p) => p.id === id)
  const ok = (p: Project): boolean => p.id !== id && !isProjectArchived(p)
  return doc.projects.slice(index + 1).find(ok) ?? doc.projects.slice(0, Math.max(0, index)).reverse().find(ok)
}

/** What a project looks like once archived: closed too, keeping when it was first closed. */
export function archived(project: Project, at: number): Project {
  return { ...project, closedAt: project.closedAt ?? at, archivedAt: at }
}

/** Takes the archive mark off. Opening, if asked, is the caller's showProject. */
export function unarchived(project: Project): Project {
  const { archivedAt: _archivedAt, ...rest } = project
  return rest
}

/** Whether this node belongs to an archived project. */
export function inArchivedProject(doc: Pick<CanvasDoc, 'projects'>, node: { projectId?: string }): boolean {
  return !!node.projectId && isProjectArchived((doc.projects ?? []).find((p) => p.id === node.projectId))
}

export const ARCHIVED_START = 'This project is archived. Unarchive it to start its sessions.'
