import { Panel, useReactFlow, ViewportPortal } from '@xyflow/react'
import { useEffect, useMemo } from 'react'
import { boundsOf, panToShow, planTidy, tidyOp, tidyResult, type TidyScope } from '../core/canvas/tidy'
import { absoluteRect } from '../core/canvas/place'
import type { CanvasDoc } from '../shared/model'
import { undoable, useStore } from './store'
import { changeTidy, closeTidy, useTidyUi } from './tidyUi'
import { visibleArea } from './viewArea'
import './tidy.css'

const sameScope = (a: TidyScope, b: TidyScope): boolean => JSON.stringify(a) === JSON.stringify(b)

/** What the scope buttons offer: the whole project, the selection, and the group in question. */
function scopeChoices(doc: CanvasDoc, scope: TidyScope, selection: string[]): { label: string; scope: TidyScope }[] {
  const out: { label: string; scope: TidyScope }[] = [{ label: 'Whole project', scope: { kind: 'project' } }]
  if (selection.length >= 2) out.push({ label: `Selection (${selection.length})`, scope: { kind: 'selection', ids: selection } })
  const groupId = scope.kind === 'group' ? scope.id : selection.length === 1 ? selection[0] : null
  const group = groupId ? doc.nodes.find((n) => n.id === groupId && n.kind === 'group') : undefined
  if (group) out.push({ label: `Group “${group.title || 'Untitled'}”`, scope: { kind: 'group', id: group.id } })
  return out
}

/**
 * The tidy preview: dashed outlines where each node would go and a bar to apply or cancel. Nothing moves until
 * Apply, which is one undo step. Drawn inside the canvas so the outlines follow it as it pans and zooms.
 */
export function TidyLayer({ sidebar }: { sidebar: boolean }): React.JSX.Element | null {
  const preview = useTidyUi((s) => s.preview)
  const doc = useStore((s) => s.doc)
  const statuses = useStore((s) => s.statuses)
  const flow = useReactFlow()

  const plan = useMemo(
    () => (preview && doc ? planTidy(doc, { projectId: preview.projectId, scope: preview.scope, byStatus: preview.byStatus, statuses, view: preview.view }) : null),
    [preview, doc, statuses]
  )
  const ghosts = useMemo(() => (plan && doc ? tidyResult(doc, plan) : []), [plan, doc])
  const moving = new Set(plan?.moves.map((m) => m.id))

  // Another project on screen, or the nodes gone: nothing left to preview.
  const stale = !!preview && (!doc || doc.activeProjectId !== preview.projectId || !plan)
  useEffect(() => {
    if (stale) closeTidy()
  }, [stale])

  useEffect(() => {
    if (!preview) return
    // The windows fade while previewing, so the outlines of where they'd go read clearly.
    document.body.classList.add('tidy-previewing')
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeTidy()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.classList.remove('tidy-previewing')
    }
  }, [preview])

  if (!preview || !doc || !plan) return null

  const apply = (): void => {
    if (plan.moves.length) undoable('tidy', [tidyOp(plan)])
    // Keep the zoom, and pan only as far as needed to keep the result in sight.
    const area = visibleArea(sidebar)
    const vp = flow.getViewport()
    const bounds = boundsOf(ghosts.map((g) => g.rect))
    if (area && bounds && vp.zoom > 0) {
      const view = { x: (area.x - vp.x) / vp.zoom, y: (area.y - vp.y) / vp.zoom, width: area.width / vp.zoom, height: area.height / vp.zoom }
      const d = panToShow(view, bounds)
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      if (d.x || d.y) void flow.setViewport({ x: vp.x - d.x * vp.zoom, y: vp.y - d.y * vp.zoom, zoom: vp.zoom }, { duration: still ? 0 : 220 })
    }
    closeTidy()
  }

  const count = plan.moves.length
  const what = plan.scope.kind === 'project' ? 'Tidy canvas' : plan.scope.kind === 'group' ? 'Tidy group' : 'Tidy selection'
  const titleOf = (id: string): string => doc.nodes.find((n) => n.id === id)?.title || ''
  return (
    <>
      <ViewportPortal>
        {ghosts.map(({ id, rect }) => {
          const group = id === plan.parentId
          const from = absoluteRect(doc, doc.nodes.find((n) => n.id === id)!)
          const changed = moving.has(id) || from.width !== rect.width || from.height !== rect.height
          return (
            <div
              key={id}
              className={`tidy-ghost${group ? ' tidy-ghost-group' : ''}${changed ? '' : ' tidy-ghost-still'}`}
              style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height }}
              aria-hidden
            >
              <span className="tidy-ghost-title">{titleOf(id)}</span>
            </div>
          )
        })}
      </ViewportPortal>
      <Panel position="top-center" className="tidy-bar" aria-label="Tidy preview">
        <strong className="tidy-bar-title">{what}</strong>
        <div className="tidy-scopes" role="group" aria-label="What to tidy">
          {scopeChoices(doc, plan.scope, preview.selection).map((c) => (
            <button
              key={c.label}
              type="button"
              className={`btn tidy-scope${sameScope(c.scope, plan.scope) ? ' tidy-scope-on' : ''}`}
              aria-pressed={sameScope(c.scope, plan.scope)}
              onClick={() => changeTidy({ scope: c.scope })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="tidy-status">
          <input type="checkbox" checked={preview.byStatus} onChange={(e) => changeTidy({ byStatus: e.target.checked })} />
          Needs you first
        </label>
        <span className="tidy-count">{count === 0 ? 'Already tidy' : count === 1 ? '1 node moves' : `${count} nodes move`}</span>
        <button type="button" className="btn" onClick={closeTidy}>
          Cancel
        </button>
        <button type="button" className="btn btn-solid" onClick={apply} autoFocus data-cmd="tidy-apply">
          {count === 0 ? 'Close' : 'Apply'}
        </button>
      </Panel>
    </>
  )
}
