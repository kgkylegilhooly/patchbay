import { useReactFlow } from '@xyflow/react'
import { bridge } from './bridge'
import { CompareStart } from './CompareStart'
import { CompareView } from './CompareView'
import { closeCompare, openComparisons, useCompareUi } from './compareUi'
import { useStore } from './store'
import './compare.css'

/** The "Try another approach" dialog and the comparison view, over the canvas, whichever is open. */
export function CompareLayer(): React.JSX.Element | null {
  const start = useCompareUi((s) => s.start)
  const view = useCompareUi((s) => s.view)
  const projectId = useStore((s) => s.doc?.activeProjectId)
  const folder = useStore((s) => s.doc?.projects.find((p) => p.id === s.doc?.activeProjectId)?.folder ?? '')
  const flow = useReactFlow()

  /** Puts a node on screen, switching to its project first. */
  const show = (id: string): void => {
    const doc = useStore.getState().doc
    const node = doc?.nodes.find((n) => n.id === id)
    if (!doc || !node) return
    const switching = !!node.projectId && node.projectId !== doc.activeProjectId
    if (switching) void bridge.dispatch({ op: 'switchProject', id: node.projectId! })
    closeCompare()
    setTimeout(() => void flow.fitView({ nodes: [{ id }], padding: 0.2, maxZoom: 1, duration: 260 }), switching ? 300 : 0)
  }

  if (!projectId) return null
  return (
    <>
      {start && (
        <CompareStart
          projectId={projectId}
          source={start.source || folder}
          brief={start.brief}
          taskId={start.taskId}
          onCancel={closeCompare}
          onStarted={(c, problem) => {
            openComparisons(c.id, problem)
            // The new groups are drawn once their doc arrives.
            setTimeout(() => void flow.fitView({ nodes: c.attempts.map((a) => ({ id: a.groupId })), padding: 0.15, maxZoom: 1, duration: 260 }), 300)
          }}
        />
      )}
      {view && <CompareView key={view.at} projectId={projectId} initial={view.id} notice={view.notice} onShow={show} onClose={closeCompare} />}
    </>
  )
}
