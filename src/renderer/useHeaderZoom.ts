import { useOnViewportChange, useReactFlow } from '@xyflow/react'
import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { afterMove, isEmptyHeaderPart, onEscape, onHeaderDoubleClick, viewportFor, type Rect, type ZoomMemory } from './headerZoom'
import { keyFocusOf } from './keys'
import { useStore } from './store'

/** The canvas's own zoom limits (App.tsx), and how much room is left around a node zoomed to. */
const LIMITS = { margin: 32, minZoom: 0.1, maxZoom: 2 }
const DURATION_MS = 280

/** Where to go back to, while the view is still where a header double-click put it. */
const useZoomMemory = create<{ memory: ZoomMemory | null }>(() => ({ memory: null }))

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The part of the canvas actually seen, in pixels from its top left: past the sessions sidebar and above the dock. */
function visibleArea(): Rect | null {
  const pane = document.querySelector('.react-flow')?.getBoundingClientRect()
  if (!pane || !pane.width || !pane.height) return null
  let left = pane.left
  let bottom = pane.bottom
  const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect()
  if (sidebar && sidebar.width && sidebar.right > left && sidebar.right < pane.right - 200) left = sidebar.right
  const dock = document.querySelector('.dock')?.getBoundingClientRect()
  if (dock && dock.height && dock.top > pane.top + 200 && dock.top < bottom) bottom = dock.top
  return { x: left - pane.left, y: 0, width: pane.right - left, height: bottom - pane.top }
}

/**
 * A node header's onDoubleClick. On the header's empty part it zooms the canvas to the node, or back to the view from
 * before if it's still zoomed there. The title, buttons and other controls keep their own double-click. Nothing is
 * moved or resized, and a node shown in the focus view or filling the canvas is left alone.
 */
export function useHeaderZoom(nodeId: string): (e: React.MouseEvent<HTMLElement>) => void {
  const flow = useReactFlow()
  return useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!isEmptyHeaderPart(e.target as Element, e.currentTarget)) return
      const s = useStore.getState()
      if (s.maximized === nodeId || (s.focus && s.focusSlots[nodeId])) return
      const internal = flow.getInternalNode(nodeId)
      const area = visibleArea()
      if (!internal || !area) return
      const rect: Rect = {
        ...internal.internals.positionAbsolute,
        width: internal.measured.width ?? internal.width ?? 0,
        height: internal.measured.height ?? internal.height ?? 0
      }
      const { go, memory } = onHeaderDoubleClick(useZoomMemory.getState().memory, nodeId, flow.getViewport(), viewportFor(rect, area, LIMITS))
      useZoomMemory.setState({ memory })
      e.stopPropagation()
      void flow.setViewport(go, { duration: reducedMotion() ? 0 : DURATION_MS })
    },
    [flow, nodeId]
  )
}

/**
 * Forgets the way back once the person pans or zooms, or switches project, and takes Esc back to the view from before
 * a header zoom. Esc only counts on the canvas itself: a terminal keeps it, as that's how an agent is interrupted.
 */
export function HeaderZoomWatcher(): null {
  const flow = useReactFlow()
  const projectId = useStore((s) => s.doc?.activeProjectId)
  useOnViewportChange({
    onEnd: (viewport) => {
      const memory = useZoomMemory.getState().memory
      const next = afterMove(memory, viewport)
      if (next !== memory) useZoomMemory.setState({ memory: next })
    }
  })
  useEffect(() => useZoomMemory.setState({ memory: null }), [projectId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (keyFocusOf(e.target as Element | null) !== 'canvas') return
      // Anything open on top takes Esc first.
      if (document.querySelector('.menu-panel, .palette, .pop, .settings, .drawer')) return
      const back = onEscape(useZoomMemory.getState().memory, flow.getViewport())
      if (!back) return
      e.preventDefault()
      e.stopPropagation()
      useZoomMemory.setState({ memory: null })
      void flow.setViewport(back.go, { duration: reducedMotion() ? 0 : DURATION_MS })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [flow])
  return null
}
