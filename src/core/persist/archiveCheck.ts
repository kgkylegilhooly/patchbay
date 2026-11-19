/**
 * An archive mark is an optional extra, so a damaged one is dropped and the project loads as it was, rather than the
 * whole save being refused. An archived project is always closed too: one marked archived but open is closed then.
 */
export function withArchiveChecked(projects: unknown): unknown {
  if (!Array.isArray(projects)) return projects
  return projects.map((p: unknown) => {
    if (typeof p !== 'object' || p === null || !('archivedAt' in p)) return p
    const { archivedAt, ...rest } = p as Record<string, unknown>
    if (typeof archivedAt !== 'number' || !Number.isFinite(archivedAt)) {
      if (archivedAt !== undefined) console.warn('Patchbay dropped a damaged archive mark on a project while loading.')
      return rest
    }
    return rest.closedAt === undefined ? { ...rest, archivedAt, closedAt: archivedAt } : { ...rest, archivedAt }
  })
}
