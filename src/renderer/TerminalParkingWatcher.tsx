import { useStore as useFlowStore } from '@xyflow/react'
import { useEffect, useRef } from 'react'
import { inActiveProject } from '../shared/model'
import type { ResourcesBridge } from '../shared/resources'
import { useStore } from './store'
import { focusedTerminalId } from './terminalRegistry'
import './resources/resources.css'
import { PARKING, parkedIds, parkingEnabled, planParking, setParked, useParkingEnabled, type Box } from './terminalParking'

declare global {
  interface Window {
    patchbayResources?: ResourcesBridge
  }
}

const TERMINAL_KINDS = new Set(['claude', 'terminal', 'run'])
/** A pan or zoom is looked at this soon after it, so a window coming into view is drawn again before it arrives. */
const MOVE_CHECK_MS = 150

/** Unloads terminal windows that have been far off-screen for a while, and loads them again as they come near. */
export function TerminalParkingWatcher(): null {
  const transform = useFlowStore((s) => s.transform)
  const enabled = useParkingEnabled()
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
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`)
      const r = el?.getBoundingClientRect()
      boxes.set(n.id, r && r.width > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null)
    }
    const keep = new Set<string>()
    const focused = focusedTerminalId()
    if (focused) keep.add(focused)
    const maximized = useStore.getState().maximized
    if (maximized) keep.add(maximized)
    const plan = planParking({ boxes, screen: { width: window.innerWidth, height: window.innerHeight }, keep, lastNear: lastNear.current, now: Date.now(), urgent })
    lastNear.current = plan.lastNear
    setParked(plan.parked)
  }

  useEffect(() => {
    const timer = setInterval(() => check.current(), PARKING.everyMs)
    const offLow = window.patchbayResources?.onLowMemory(() => check.current(true))
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
  }, [transform, enabled])

  return null
}
