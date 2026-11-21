import { useStore as useFlowStore } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import { inActiveProject } from '../shared/model'
import { resourcesBridge } from './resources/resourcesUi'
import { useStore } from './store'
import { focusedTerminalId } from './terminalRegistry'
import './resources/resources.css'
import { PARKING, parkedIds, parkingEnabled, planParking, setParked, useParkingEnabled, type Box } from './terminalParking'

const TERMINAL_KINDS = new Set(['claude', 'terminal', 'run'])
/** A pan or zoom is looked at this soon after it, so a window coming into view is drawn again before it arrives. */
const MOVE_CHECK_MS = 150

/** Unloads terminal windows that have been far off-screen for a while, and loads them again as they come near. */
export function TerminalParkingWatcher(): null {
  const transform = useFlowStore((s) => s.transform)
  const enabled = useParkingEnabled()
  // A window moved into a Focus view pane or maximized is on show at once.
  const shownElsewhere = useStore((s) => `${s.maximized ?? ''}|${s.focus ? Object.keys(s.focusSlots).join(',') : ''}`)
  const lastNear = useRef(new Map<string, number>())
  const check = useRef<(urgent?: boolean) => void>(() => {})

  check.current = (urgent = false) => {
    const doc = useStore.getState().doc
    if (!doc || !parkingEnabled()) {
      lastNear.current = new Map()
      setParked(new Set())
      return
    }
    const boxes = new Map<string, Box | null>()
    for (const n of doc.nodes) {
      if (!TERMINAL_KINDS.has(n.kind) || !inActiveProject(doc, n)) continue
      // The terminal itself, wherever its card is drawn: on the canvas, maximized, or in a Focus view pane.
      const el = document.querySelector(`.term[data-term-node="${CSS.escape(n.id)}"]`)
      const r = el?.getBoundingClientRect()
      boxes.set(n.id, r && r.width > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null)
    }
    const keep = new Set<string>()
    const focused = focusedTerminalId()
    if (focused) keep.add(focused)
    const { maximized, focus, focusSlots } = useStore.getState()
    if (maximized) keep.add(maximized)
    // Every window in a Focus view pane is on show.
    if (focus) for (const id of Object.keys(focusSlots)) keep.add(id)
    // Zoomed out so far that windows are flat status fills: those unloaded stay so, rather than all drawn again at once.
    const overview = document.querySelector<HTMLElement>('.react-flow')?.dataset.zoomTier === 'overview'
    const hold = overview ? new Set(parkedIds()) : undefined
    const plan = planParking({ boxes, screen: { width: window.innerWidth, height: window.innerHeight }, keep, hold, lastNear: lastNear.current, now: Date.now(), urgent })
    lastNear.current = plan.lastNear
    setParked(plan.parked)
  }

  useEffect(() => {
    const timer = setInterval(() => check.current(), PARKING.everyMs)
    const offLow = resourcesBridge()?.onLowMemory(() => check.current(true))
    return () => {
      clearInterval(timer)
      offLow?.()
    }
  }, [])

  useEffect(() => {
    // Only a view coming near a parked window needs an answer quickly.
    if (!parkedIds().size && enabled) return
    const timer = setTimeout(() => check.current(), MOVE_CHECK_MS)
    return () => clearTimeout(timer)
  }, [transform, enabled, shownElsewhere])

  return null
}
