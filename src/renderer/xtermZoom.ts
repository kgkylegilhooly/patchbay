const EVENTS = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const

/**
 * Events already rewritten. Every terminal on the canvas listens on the window, so two can see the same event, such as
 * when a drag that started in one passes over another. It's corrected once, by the first.
 */
const corrected = new WeakMap<MouseEvent, { x: number; y: number }>()

/**
 * Where the pointer really was on screen, for placing a menu. A rewritten event's clientX and clientY say where it
 * would have been at 100%, so a link menu at 71% zoom opened well below the link.
 */
export function screenPoint(ev: MouseEvent): { x: number; y: number } {
  return corrected.get(ev) ?? { x: ev.clientX, y: ev.clientY }
}

/**
 * xterm works out which cell the mouse is on by assuming it isn't scaled, but the canvas scales
 * every node. This rewrites each mouse event's coordinates, before xterm sees it, to what they'd be
 * at 100%, so selecting text and clicking links land on the right cell at any zoom. A drag that
 * started in this terminal stays corrected when the mouse leaves it.
 */
export function installZoomCompensation(host: HTMLElement): () => void {
  let dragging = false

  const correct = (ev: MouseEvent): void => {
    const screen = host.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) return
    const inside = ev.target instanceof Node && screen.contains(ev.target)
    if (ev.type === 'mousedown' && inside) dragging = true
    const active = inside || dragging
    if (ev.type === 'mouseup') dragging = false
    if (!active || corrected.has(ev)) return

    const rect = screen.getBoundingClientRect()
    const scale = screen.offsetWidth ? rect.width / screen.offsetWidth : 1
    if (Math.abs(scale - 1) < 0.001) return
    const clientX = rect.left + (ev.clientX - rect.left) / scale
    const clientY = rect.top + (ev.clientY - rect.top) / scale
    corrected.set(ev, { x: ev.clientX, y: ev.clientY })
    Object.defineProperty(ev, 'clientX', { get: () => clientX, configurable: true })
    Object.defineProperty(ev, 'clientY', { get: () => clientY, configurable: true })
  }

  for (const type of EVENTS) window.addEventListener(type, correct, true)
  return () => {
    for (const type of EVENTS) window.removeEventListener(type, correct, true)
  }
}
