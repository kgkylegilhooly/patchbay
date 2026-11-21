import { useSyncExternalStore } from 'react'

/**
 * Unloading windows far off-screen. A terminal's drawn history lives in its xterm instance, about 12 bytes a character
 * cell, so a window with 10,000 lines of scrollback at 100 columns holds about 12 MB. One parked for a while is let go;
 * its session carries on in the host, and when it comes near the screen again it's drawn afresh from the session's
 * saved output, as it is when you switch back to a project tab. Nothing a session printed is lost by this.
 */
export const PARKING = {
  /** How long a window must have been far off-screen. */
  afterMs: 3 * 60_000,
  /** "Far" is more than this many screens away from the window's edge, so a pan doesn't catch one unloaded. */
  marginScreens: 1,
  /** How often to look, besides whenever the view moves. */
  everyMs: 15_000
} as const

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Whether `box` is within `margin` screens of the screen. */
export function nearScreen(box: Box, screen: { width: number; height: number }, margin: number = PARKING.marginScreens): boolean {
  const mx = screen.width * margin
  const my = screen.height * margin
  return box.right >= -mx && box.left <= screen.width + mx && box.bottom >= -my && box.top <= screen.height + my
}

export interface ParkingInput {
  /** Each window's box on screen. Null when it can't be found, which keeps it loaded. */
  boxes: Map<string, Box | null>
  screen: { width: number; height: number }
  /** Windows never unloaded now: the one being typed in, for one. */
  keep: Set<string>
  /** When each window was last near the screen. */
  lastNear: Map<string, number>
  now: number
  /** Memory is short: unload every far window at once. */
  urgent?: boolean
  afterMs?: number
}

/** Which windows to unload, and the updated record of when each was last near. Windows that went away drop out. */
export function planParking(input: ParkingInput): { parked: Set<string>; lastNear: Map<string, number> } {
  const afterMs = input.afterMs ?? PARKING.afterMs
  const parked = new Set<string>()
  const lastNear = new Map<string, number>()
  for (const [id, box] of input.boxes) {
    const near = !box || input.keep.has(id) || nearScreen(box, input.screen)
    let since = near ? input.now : (input.lastNear.get(id) ?? input.now)
    // Unloaded in a hurry, it stays unloaded until it comes near, as if it had waited its time.
    if (!near && input.urgent) since = Math.min(since, input.now - afterMs)
    lastNear.set(id, since)
    if (!near && input.now - since >= afterMs) parked.add(id)
  }
  return { parked, lastNear }
}

const OFF_KEY = 'patchbay.unloadOffscreen'

/** On unless turned off in Settings > Background sessions. Kept in this window, as view settings are. */
export function parkingEnabled(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) !== 'off'
  } catch {
    return true
  }
}

let parkedNow: Set<string> = new Set()
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const cb of listeners) cb()
}

export function setParkingEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(OFF_KEY)
    else localStorage.setItem(OFF_KEY, 'off')
  } catch {
    // Only a view preference.
  }
  if (!on) setParked(new Set())
  emit()
}

export function setParked(next: Set<string>): void {
  if (next.size === parkedNow.size && [...next].every((id) => parkedNow.has(id))) return
  parkedNow = next
  emit()
}

export const parkedIds = (): ReadonlySet<string> => parkedNow

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Whether this window is unloaded now. */
export function useParked(id: string): boolean {
  return useSyncExternalStore(subscribe, () => parkedNow.has(id))
}

export function useParkingEnabled(): boolean {
  return useSyncExternalStore(subscribe, parkingEnabled)
}
