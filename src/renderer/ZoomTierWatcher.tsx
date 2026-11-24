import { useStore as useFlowStore } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import { openHeaderMenu, useHeaderMenu } from './nodes/headerMenu'
import { headScale, nextTier, type ZoomTier } from './zoomTier'
import { setCanvasTier } from './terminalPace'

/**
 * What --head-scale is set on: the parts of a node zoom.css draws at their on-screen size, and the strips that move
 * down under a tile. Set there rather than on the whole canvas, so a zoom step restyles those and not every terminal.
 */
const SCALED = '.react-flow :is(.unit > :not(.unit-body), .wb > .wb-head, .rack-head, .note > :is(.note-head, .note-far), .tidy-ghost)'

/**
 * Puts the zoom tier on the canvas as `data-zoom-tier`, and the header scale as `--head-scale`, for zoom.css to draw
 * headers by. A window shown maximized or in a focus pane is drawn outside the canvas, so it never takes a tier.
 * Also: Shift+F10 on a window, its terminal included, opens its ⋯ menu, and moving the view closes that menu.
 */
export function ZoomTierWatcher(): null {
  const transform = useFlowStore((s) => s.transform)
  const canvas = useFlowStore((s) => s.domNode)
  const zoom = transform[2]
  const tier = useRef<ZoomTier | null>(null)
  const rule = useRef<HTMLStyleElement | null>(null)
  useEffect(() => {
    if (!canvas) return
    tier.current = nextTier(tier.current, zoom)
    if (canvas.dataset.zoomTier !== tier.current) canvas.dataset.zoomTier = tier.current
    setCanvasTier(tier.current)
    if (!rule.current) {
      rule.current = document.createElement('style')
      rule.current.dataset.headScale = ''
      document.head.appendChild(rule.current)
    }
    const scale = headScale(zoom, tier.current)
    const text = `${SCALED} { --head-scale: ${scale}; }`
    if (rule.current.textContent !== text) rule.current.textContent = text
    // Near headers drawn larger have less room, so zoom.css lets the status word outlast the context share.
    const scaled = tier.current === 'near' && scale > 1
    if (scaled !== ('headScaled' in canvas.dataset)) {
      if (scaled) canvas.dataset.headScaled = ''
      else delete canvas.dataset.headScaled
    }
  }, [zoom, canvas])
  useEffect(() => () => rule.current?.remove(), [])

  // The ⋯ menu is drawn at a fixed spot on screen, so a pan or zoom by keys would leave it behind its button.
  const moved = useRef(transform)
  useEffect(() => {
    if (moved.current === transform) return
    moved.current = transform
    if (useHeaderMenu.getState().open) useHeaderMenu.setState({ open: null })
  }, [transform])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F10' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      const focused = document.activeElement
      // A text field keeps its keys. A terminal doesn't need Shift+F10, so there it opens the menu too.
      if (focused?.closest('input, textarea:not(.xterm-helper-textarea), [contenteditable]')) return
      // On the canvas, or drawn maximized or in a focus pane, which are outside the canvas.
      const holder = focused?.closest('.react-flow__node, .unit-maximized, .unit-in-pane')
      const id = holder?.querySelector<HTMLElement>('[data-tool="more"]')?.dataset.nodeId
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      openHeaderMenu(id)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return null
}
