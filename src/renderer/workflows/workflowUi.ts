import { create } from 'zustand'
import type { RecipeSource } from '../../shared/recipe'
import type { Workflow } from '../../shared/workflow'
import type { WorkflowEntry } from '../../shared/workflowBridge'
import { workflows } from '../workflowBridge'

/** An open edit: the definition as it is being changed, and where it will be saved. */
export interface Editing {
  workflow: Workflow
  /** The file it came from, which Save replaces. Absent for a new one, or a copy. */
  file?: string
  where: Exclude<RecipeSource, 'built-in'>
}

/**
 * The workflow side of the recipe picker: which workflow is chosen, and an open edit. Kept apart from the canvas
 * store, as recipes' is.
 */
export const useWorkflowUi = create<{
  entries: WorkflowEntry[] | null
  repo: string | null
  chosen: string | null
  editing: Editing | null
  /** The run panel's run, when it is open. */
  panelRun: string | null
}>(() => ({ entries: null, repo: null, chosen: null, editing: null, panelRun: null }))

export async function loadWorkflows(projectId: string): Promise<void> {
  const l = await workflows.list(projectId)
  useWorkflowUi.setState({ entries: l.entries, repo: l.repo })
}

export const chooseWorkflow = (ref: string | null): void => useWorkflowUi.setState({ chosen: ref, editing: null })
export const editWorkflow = (e: Editing | null): void => useWorkflowUi.setState({ editing: e })
export const leaveWorkflows = (): void => useWorkflowUi.setState({ chosen: null, editing: null })
export const openRunPanel = (runId: string | null): void => useWorkflowUi.setState({ panelRun: runId })
