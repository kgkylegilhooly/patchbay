import { formatBytes, type ArchiveResult } from '../shared/projects'
import { plural } from './projectsView'

/** What the toast after an archive says: one line first, then anything else worth knowing, with warnings apart. */
export interface ArchivedToast {
  projectId: string
  headline: string
  details: string[]
  /** Things still to do. A toast with these stays until it's closed. */
  warnings: string[]
}

export function archivedToast(projectId: string, name: string, result: Extract<ArchiveResult, { ok: true }>, clearedScrollback: boolean): ArchivedToast {
  const details: string[] = []
  const warnings: string[] = []
  if (clearedScrollback) details.push(`Cleared ${formatBytes(result.freedBytes)} of saved terminal output.`)
  if (result.clearedSites.length) details.push(`Cleared storage and cookies for ${result.clearedSites.join(', ')}. Sign-ins set for a wider domain may remain.`)
  if (result.keptSites.length) details.push(`Left alone, since another project shows them: ${result.keptSites.join(', ')}.`)
  if (result.stillRunning.length) {
    warnings.push(`Still running: ${result.stillRunning.join(', ')}. Stop ${result.stillRunning.length === 1 ? 'it' : 'them'} from the project after unarchiving.`)
  }
  if (result.problem) warnings.push(result.problem)
  return {
    projectId,
    headline: `Archived ${name}. ${result.stopped ? `Stopped ${plural(result.stopped, 'session')}.` : 'Nothing was running.'}`,
    details,
    warnings
  }
}
