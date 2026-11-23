import { Panel, useReactFlow, ViewportPortal, type Viewport } from '@xyflow/react'
import { useEffect, useMemo, useRef } from 'react'
import { boundsOf, panToShow, planTidy, tidyOp, tidyResult, type TidyScope } from '../core/canvas/tidy'
import { absoluteRect, type Rect } from '../core/canvas/place'
import type { AgentStatus, CanvasDoc } from '../shared/model'
import { undoable, useStore } from './store'
import { changeTidy, closeTidy, useTidyUi } from './tidyUi'
import { visibleArea } from './viewArea'
import { viewportFor } from './headerZoom'
import './tidy.css'

/** Room the bar takes at the top of the safe area, so outlines aren't brought into view under it. */
const BAR_ROOM = 64
const still = (): boolean => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The safe area in canvas coordinates, below the bar when it's open. */
function canvasView(area: Rect, vp: Viewport, below = 0): Rect {
  return { x: (area.x - vp.x) / vp.zoom, y: (area.y + below - vp.y) / vp.zoom, width: area.width / vp.zoom, height: (area.height - below) / vp.zoom }
}

const NO_STATUSES: Record<string, AgentStatus> = {}

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
  // Only a preview uses the doc and the statuses. Without one, a status or a doc change renders nothing here.
  const doc = useStore((s) => (preview ? s.doc : null))
  const statuses = useStore((s) => (preview ? s.statuses : NO_STATUSES))
  const flow = useReactFlow()

  const plan = useMemo(
    () => (preview && doc ? planTidy(doc, { projectId: preview.projectId, scope: preview.scope, byStatus: preview.byStatus, statuses, view: preview.view }) : null),
    [preview, doc, statuses]
  )
  const ghosts = useMemo(() => (plan && doc ? tidyResult(doc, plan) : []), [plan, doc])
  const moving = new Set(plan?.moves.map((m) => m.id))
  const ghostsNow = useRef(ghosts)
  ghostsNow.current = ghosts
  /** The view from before the preview panned to show its outlines, which Cancel goes back to. */
  const before = useRef<Viewport | null>(null)

  /**
   * Pans, at the same zoom, only as far as it takes to bring the outlines into the safe area. With `zoomOut`, outlines
   * too big for it at this zoom are fitted into it instead. Returns the view from before, when it moved.
   */
  const panToGhosts = (below: number, zoomOut: boolean): Viewport | null => {
    const area = visibleArea(sidebar)
    const vp = flow.getViewport()
    const bounds = boundsOf(ghostsNow.current.map((g) => g.rect))
    if (!area || !bounds || !(vp.zoom > 0) || area.height <= below) return null
    const view = canvasView(area, vp, below)
    const duration = still() ? 0 : 220
    if (zoomOut && (bounds.width > view.width || bounds.height > view.height)) {
      const shown = { x: area.x, y: area.y + below, width: area.width, height: area.height - below }
      void flow.setViewport(viewportFor(bounds, shown, { margin: 16, minZoom: 0.1, maxZoom: vp.zoom }), { duration })
      return vp
    }
    const d = panToShow(view, bounds)
    if (!d.x && !d.y) return null
    void flow.setViewport({ x: vp.x - d.x * vp.zoom, y: vp.y - d.y * vp.zoom, zoom: vp.zoom }, { duration })
    return vp
  }
  const cancel = (): void => {
    if (before.current) void flow.setViewport(before.current, { duration: still() ? 0 : 220 })
    before.current = null
    closeTidy()
  }
  const cancelNow = useRef(cancel)
  cancelNow.current = cancel

  // Where things would go is brought into view when the preview opens, so the outlines can be seen. Cancel goes back.
  const opened = !!preview && !!plan
  useEffect(() => {
    before.current = opened ? panToGhosts(BAR_ROOM, true) : null
    // Only on opening: changing the scope or the order shouldn't pan again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

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
      cancelNow.current()
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
    // After a zoom out to show the outlines, the result is already in view.
    if (!before.current) panToGhosts(0, false)
    before.current = null
    closeTidy()
  }

  const count = plan.moves.length
  const what = plan.scope.kind === 'project' ? 'Tidy canvas' : plan.scope.kind === 'group' ? 'Tidy group' : 'Tidy selection'
  const titleOf = (id: string): string => doc.nodes.find((n) => n.id === id)?.title || ''
  // Centred over the safe area rather than the window, so the sidebar never hides its title or Cancel.
  const area = visibleArea(sidebar)
  const barPlace = area ? { left: area.x + area.width / 2, top: area.y, margin: 0, maxWidth: area.width } : undefined
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
      <Panel position="top-center" className="tidy-bar" aria-label="Tidy preview" style={barPlace}>
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
        <button type="button" className="btn" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-solid" onClick={apply} autoFocus data-cmd="tidy-apply">
          {count === 0 ? 'Close' : 'Apply'}
        </button>
      </Panel>
    </>
  )
}
