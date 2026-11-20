import { useStore as useFlowStore } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import { openHeaderMenu } from './nodes/headerMenu'
import { headScale, nextTier, type ZoomTier } from './zoomTier'

/**
 * Puts the zoom tier on the canvas as `data-zoom-tier`, and the header scale as `--head-scale`, for zoom.css to draw
 * headers by. A window shown maximized or in a focus pane is drawn outside the canvas, so it never takes a tier.
 * Also: Shift+F10 on a focused window opens its ⋯ menu.
 */
export function ZoomTierWatcher(): null {
  const zoom = useFlowStore((s) => s.transform[2])
  const canvas = useFlowStore((s) => s.domNode)
  const tier = useRef<ZoomTier | null>(null)
  useEffect(() => {
    if (!canvas) return
    tier.current = nextTier(tier.current, zoom)
    if (canvas.dataset.zoomTier !== tier.current) canvas.dataset.zoomTier = tier.current
    const scale = String(headScale(zoom, tier.current))
    if (canvas.style.getPropertyValue('--head-scale') !== scale) canvas.style.setProperty('--head-scale', scale)
  }, [zoom, canvas])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F10' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      const focused = document.activeElement
      const node = focused?.closest<HTMLElement>('.react-flow__node')
      // A terminal or a text field keeps its keys.
      if (!node?.dataset.id || focused?.closest('.xterm, input, textarea, [contenteditable]')) return
      if (!node.querySelector('[data-tool="more"]')) return
      e.preventDefault()
      e.stopPropagation()
      openHeaderMenu(node.dataset.id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return null
}
