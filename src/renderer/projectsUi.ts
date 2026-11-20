import { create } from 'zustand'
import type { ArchivedToast } from './archiveToast'

/** Which projects sheet is open. Kept apart from the canvas store, so it adds no state there. */
export const useProjectsUi = create<{
  manager: boolean
  archive: string | null
  /** Why the manager opened, such as a jump to a node in an archived project. */
  notice: string | null
  /** The toast after an archive, with its Unarchive button. */
  archived?: ArchivedToast | null
}>(() => ({ manager: false, archive: null, notice: null, archived: null }))

export const showArchived = (toast: ArchivedToast | null): void => useProjectsUi.setState({ archived: toast })

export const openProjects = (notice: string | null = null): void => useProjectsUi.setState({ manager: true, notice })
export const closeProjects = (): void => useProjectsUi.setState({ manager: false, archive: null, notice: null })
/** The confirmation that says what archiving this project does. Main does the archiving. */
export const askArchive = (id: string): void => useProjectsUi.setState({ archive: id })
export const closeArchive = (): void => useProjectsUi.setState({ archive: null })

const SUGGEST_KEY = 'patchbay.projects.suggestArchiveDays'
export const SUGGEST_CHOICES = [0, 14, 30, 60, 90] as const

/** Off (0) unless chosen. Only for this window's own reminder: nothing is ever archived by itself. */
export function readSuggestDays(): number {
  try {
    const n = Number(localStorage.getItem(SUGGEST_KEY))
    return (SUGGEST_CHOICES as readonly number[]).includes(n) ? n : 0
  } catch {
    return 0
  }
}

export function saveSuggestDays(days: number): void {
  try {
    localStorage.setItem(SUGGEST_KEY, String(days))
  } catch {
    // A preference that can't be kept still applies until the window closes.
  }
}
