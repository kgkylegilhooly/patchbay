import { switchTriggersPaused } from './triggersPaused'
import type { Task } from '../shared/task'
import { interruptEntry, stopRunsEntry, type Commands, type MenuEntry } from './menus'
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
export function workLabel(waiting: number, triggersPaused = false): string {
  const parts = [waiting ? `${waiting} waiting for review` : null, triggersPaused ? 'all triggers are paused' : null].filter(Boolean)
  return parts.length ? `Work: ${parts.join(', ')}` : 'Work'
}

export function workMenu(
  c: Pick<Commands, 'toggleRecent' | 'interruptNodes' | 'stopRuns'>,
  o: { waiting: number; triggersPaused: boolean; working?: Array<{ id: string; title: string }>; running?: Array<{ id: string; title: string }> }
): MenuEntry[] {
  return [
    { id: 'search', label: 'Search conversations and notes…', icon: 'find', run: () => toggleSearch() },
    { id: 'new-from-recipe', label: 'Recipes and workflows…', icon: 'team', run: () => openRecipePicker() },
    'separator',
    // The count stands where a shortcut would: the inbox has none, and it's what the person looks for.
    { id: 'review-inbox', label: 'Review inbox…', icon: 'checklist', ...(o.waiting ? { shortcut: `${o.waiting} waiting` } : {}), run: () => openReviewInbox() },
    { id: 'comparisons', label: 'Comparisons…', icon: 'branch', run: () => openComparisons() },
    // Holds every armed trigger, keeping each armed (F54). See triggersPaused.ts and the trigger service's paused.
    { id: 'pause-triggers', label: 'Pause all triggers', icon: 'trigger', checked: o.triggersPaused, run: () => void switchTriggersPaused() },
    // Every working agent in this project, after naming them (F67), as a group's menu does for its own (F44).
    ...interruptEntry(c, o.working ?? []),
    // And every command still running in it, such as dev servers left after a session (F73).
    ...stopRunsEntry(c, o.running ?? []),
    'separator',
    { id: 'file-shelf', label: 'Files shelf…', icon: 'file', run: () => toggleFileShelf() },
    { id: 'recent', label: 'Closed conversations', icon: 'recent', run: () => c.toggleRecent() },
    { id: 'manage-projects', label: 'Projects…', icon: 'project', run: () => openProjects() }
  ]
}

/** Room kept between a menu and the window's edge. */
const EDGE = 8

/**
 * Where a menu over a dock button goes, relative to the dock: at the button, moved left as far as it takes to keep
 * its right edge inside the window, and never past the window's left edge.
 */
export function menuLeftWithin(o: { dockLeft: number; button: number; width: number; windowWidth: number }): number {
  const maxRight = o.windowWidth - EDGE - o.dockLeft
  return Math.max(EDGE - o.dockLeft, Math.min(o.button, maxRight - o.width))
}
