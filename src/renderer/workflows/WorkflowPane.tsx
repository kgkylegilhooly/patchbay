import { WorkflowEditor } from './WorkflowEditor'
import { WorkflowStart } from './WorkflowStart'
import { editWorkflow, useWorkflowUi } from './workflowUi'
import './workflows.css'

/** The recipe picker's right side when a workflow is chosen: its run form, or the editor. */
export function WorkflowPane({ projectId, onStart, onCancel }: { projectId: string; onStart: (r: { group: string }) => void; onCancel: () => void }): React.JSX.Element | null {
  const entries = useWorkflowUi((s) => s.entries)
  const chosen = useWorkflowUi((s) => s.chosen)
  const editing = useWorkflowUi((s) => s.editing)
  if (editing) {
    // Keyed by where it came from, so opening another workflow starts a fresh edit.
    return <WorkflowEditor key={`${editing.file ?? 'new'}:${chosen ?? ''}`} projectId={projectId} editing={editing} onCancel={() => (chosen ? editWorkflow(null) : onCancel())} />
  }
  const entry = entries?.find((e) => e.ref === chosen)
  if (!entry) return null
  return <WorkflowStart projectId={projectId} entry={entry} onStart={onStart} onCancel={onCancel} />
}

/** Whether the picker shows a workflow rather than a recipe. */
export const useWorkflowShown = (): boolean => useWorkflowUi((s) => s.chosen !== null || s.editing !== null)
