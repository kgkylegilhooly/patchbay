import { useEffect } from 'react'
import { blankWorkflow } from './editModel'
import { chooseWorkflow, editWorkflow, loadWorkflows, useWorkflowUi } from './workflowUi'
import { workflows } from '../workflowBridge'

const SOURCE_LABEL = { 'built-in': 'Built-in', personal: 'Personal', repository: 'Repository' } as const

/** The recipe picker's second section: workflows, which run steps in order, beside recipes, which set up nodes. */
export function WorkflowList({ projectId, onPick }: { projectId: string; onPick: () => void }): React.JSX.Element {
  const entries = useWorkflowUi((s) => s.entries)
  const chosen = useWorkflowUi((s) => s.chosen)
  const editing = useWorkflowUi((s) => s.editing)
  const repo = useWorkflowUi((s) => s.repo)

  useEffect(() => {
    // A list from the last time the picker was open would be shown, then replaced: start from none.
    useWorkflowUi.setState({ entries: null })
    void loadWorkflows(projectId)
  }, [projectId])

  return (
    <div className="workflow-list" role="listbox" aria-label="Workflows">
      <span className="field-label workflow-list-label">Workflows</span>
      {!entries && <p className="recipe-dim">Reading workflows…</p>}
      {entries?.length === 0 && <p className="recipe-dim">None yet.</p>}
      {/* Nothing clickable until the list is in: a button drawn early moves when it arrives, under a quick click. */}
      {entries?.map((e) => (
        <button
          type="button"
          key={e.ref}
          role="option"
          aria-selected={e.ref === chosen && !editing}
          className={`recipe-item${e.ref === chosen && !editing ? ' recipe-item-on' : ''}${e.workflow && !e.problem ? '' : ' recipe-item-off'}`}
          data-workflow={e.name}
          onClick={() => {
            onPick()
            chooseWorkflow(e.ref)
          }}
        >
          <span className="recipe-item-name">{e.name}</span>
          <span className={`recipe-source recipe-source-${e.source}`}>{SOURCE_LABEL[e.source]}</span>
          {e.problem && <span className="recipe-why">{e.problem}</span>}
        </button>
      ))}
      {entries && <button
        type="button"
        className={`recipe-item workflow-new${editing && !editing.file && !chosen ? ' recipe-item-on' : ''}`}
        data-workflow-new
        onClick={() => {
          onPick()
          chooseWorkflow(null)
          editWorkflow({ workflow: blankWorkflow(''), where: 'personal' })
        }}
      >
        <span className="recipe-item-name">+ New workflow</span>
      </button>}
      <p className="workflow-list-foot">
        Files:{' '}
        <button type="button" className="workflow-link" onClick={() => void workflows.openFolder(projectId, 'personal')}>
          personal
        </button>
        {repo && (
          <>
            {' · '}
            <button type="button" className="workflow-link" onClick={() => void workflows.openFolder(projectId, 'repository')}>
              repository
            </button>
          </>
        )}
      </p>
    </div>
  )
}
