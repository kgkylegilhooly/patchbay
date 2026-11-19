import { tabStep } from '../core/canvas/projectOps'
import { dispatch, undoable, useStore } from './store'

/** Moves a tab, undoably like other layout edits. */
export function moveProjectTab(id: string, before: string | null): void {
  undoable('move project tab', [{ op: 'moveProject', id, before }])
}

/** Move left or Move right, among the open tabs. Does nothing at the ends. */
export function stepProjectTab(id: string | undefined, step: -1 | 1): void {
  const doc = useStore.getState().doc
  const to = doc && id ? tabStep(doc.projects, id, step) : undefined
  if (id && to) moveProjectTab(id, to.before)
}

/** Brings it back as a closed project. Opening it after is a plain reopen. */
export function unarchiveProject(id: string): void {
  dispatch({ op: 'unarchiveProject', id, open: false })
}
