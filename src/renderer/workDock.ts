import type { Task } from '../shared/task'
import type { Commands, MenuEntry } from './menus'
import { toggleSearch } from './searchUi'
import { openRecipePicker } from './recipeUi'
import { openReviewInbox } from './reviewInboxUi'
import { openComparisons } from './compareUi'
import { toggleFileShelf } from './fileShelfUi'
import { openProjects } from './projectsUi'

/**
 * The dock's Work menu: the places work is found and finished, one click from the canvas. Each item has its action's
 * id, so the menu shows the same shortcut as the palette and the menu bar.
 */

/** Submissions waiting for the person: submitted, ready or not. The same rule as the review inbox's queue. */
export function waitingForReview(tasks: readonly Pick<Task, 'state' | 'submissionId'>[] | undefined): number {
  return (tasks ?? []).filter((t) => !!t.submissionId && (t.state === 'ready-for-review' || t.state === 'blocked')).length
}

/** What the Work button says to a screen reader, with what's waiting. */
export function workLabel(waiting: number): string {
  return waiting ? `Work: ${waiting} waiting for review` : 'Work'
}

export function workMenu(c: Pick<Commands, 'toggleRecent'>, o: { waiting: number }): MenuEntry[] {
  return [
    { id: 'search', label: 'Search conversations and notes…', icon: 'find', run: () => toggleSearch() },
    { id: 'new-from-recipe', label: 'Recipes and workflows…', icon: 'team', run: () => openRecipePicker() },
    'separator',
    // The count stands where a shortcut would: the inbox has none, and it's what the person looks for.
    { id: 'review-inbox', label: 'Review inbox…', icon: 'checklist', ...(o.waiting ? { shortcut: `${o.waiting} waiting` } : {}), run: () => openReviewInbox() },
    { id: 'comparisons', label: 'Comparisons…', icon: 'branch', run: () => openComparisons() },
    'separator',
    { id: 'file-shelf', label: 'Files shelf…', icon: 'file', run: () => toggleFileShelf() },
    { id: 'recent', label: 'Closed conversations', icon: 'recent', run: () => c.toggleRecent() },
    { id: 'manage-projects', label: 'Projects…', icon: 'project', run: () => openProjects() }
  ]
}
