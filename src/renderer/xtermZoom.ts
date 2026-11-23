const EVENTS = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const

/**
 * Events already rewritten, so a terminal never corrects one twice. See screenPoint.
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
 * Which terminal an event belongs to, and which one a drag is now in. A drag that started in a terminal stays with it
 * until the button comes up, even over another terminal, since that's the one selecting. Pure, so it can be tested.
 */
export function routeEvent<H>(type: string, inside: H | null, dragging: H | null): { host: H | null; dragging: H | null } {
  if (type === 'mousedown') return { host: inside, dragging: inside }
  const host = dragging ?? inside
  return { host, dragging: type === 'mouseup' ? null : dragging }
}

/** Terminals on the page, by their host element. One set of window listeners serves them all. */
const hosts = new Set<HTMLElement>()
let dragging: HTMLElement | null = null

/** The registered terminal host the event's target is in, if it's on a terminal's screen. */
function hostUnder(ev: MouseEvent): HTMLElement | null {
  const target = ev.target
  if (!(target instanceof Element)) return null
  const screen = target.closest('.xterm-screen')
  if (!screen) return null
  for (let el = screen.parentElement; el; el = el.parentElement) if (hosts.has(el)) return el
  return null
}

function correct(ev: MouseEvent): void {
  const route = routeEvent(ev.type, hostUnder(ev), dragging && dragging.isConnected && hosts.has(dragging) ? dragging : null)
  dragging = route.dragging
  const host = route.host
  if (!host || corrected.has(ev)) return
  const screen = host.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return
  const rect = screen.getBoundingClientRect()
  const scale = screen.offsetWidth ? rect.width / screen.offsetWidth : 1
  if (Math.abs(scale - 1) < 0.001) return
  const clientX = rect.left + (ev.clientX - rect.left) / scale
  const clientY = rect.top + (ev.clientY - rect.top) / scale
  corrected.set(ev, { x: ev.clientX, y: ev.clientY })
  Object.defineProperty(ev, 'clientX', { get: () => clientX, configurable: true })
  Object.defineProperty(ev, 'clientY', { get: () => clientY, configurable: true })
}

/**
 * xterm works out which cell the mouse is on by assuming it isn't scaled, but the canvas scales
 * every node. This rewrites each mouse event's coordinates, before xterm sees it, to what they'd be
 * at 100%, so selecting text and clicking links land on the right cell at any zoom. A drag that
 * started in this terminal stays corrected when the mouse leaves it. Every terminal shares one set of window
 * listeners: with one per terminal, each mouse move ran a lookup in every terminal on the canvas.
 */
export function installZoomCompensation(host: HTMLElement): () => void {
  if (hosts.size === 0) for (const type of EVENTS) window.addEventListener(type, correct, true)
  hosts.add(host)
  return () => {
    hosts.delete(host)
    if (dragging === host) dragging = null
    if (hosts.size === 0) for (const type of EVENTS) window.removeEventListener(type, correct, true)
  }
}
