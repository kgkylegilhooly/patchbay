import type { NodeMessage } from '../shared/contract'
import type { Edge } from '../shared/model'

/** Every kind of cable on the canvas. `trigger` is drawn from a trigger's target and is never saved as an edge. */
export type CableKind = Edge['kind'] | 'trigger'

/**
 * Which way a cable runs. An opener opens the node at the far end, a waiting node waits on the one that starts the
 * cable, and a trigger sends down it, so those go from their start to their end. A link gives both ends the same access.
 */
export function cableDirection(kind: CableKind): 'forward' | 'both' {
  return kind === 'link' ? 'both' : 'forward'
}

/** How long a message's pulse shows on its cable. */
export const PULSE_MS = 2600

/**
 * The cable a message between two nodes travels down, and whether that's against the cable's own direction. A link
 * says most about who may message whom, so it's preferred, then the cable from the node that opened the other.
 */
export function pulseCable(edges: Edge[], from: string, to: string): { id: string; reverse: boolean } | null {
  const between = edges.filter((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))
  const edge = between.find((e) => e.kind === 'link') ?? between.find((e) => e.kind === 'opened') ?? between[0]
  return edge ? { id: edge.id, reverse: edge.from !== from } : null
}

/** The latest messages either way between the two nodes a cable joins, oldest first, as its panel lists them. */
export function cableMessages(messages: NodeMessage[], a: string, b: string, limit = 6): NodeMessage[] {
  return messages.filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a)).slice(-limit)
}

/** Below this the dots are too small to read, so moving them only costs paint. */
export const FAR_ZOOM = 0.3

export function isFarZoom(zoom: number): boolean {
  return zoom < FAR_ZOOM
}

/**
 * The animation is plain CSS, so a React render never runs for it. These two attributes pause it while the view moves
 * and while zoomed far out. They're set directly on the element, so changing them renders nothing either.
 */
export function setCableMotion(stage: HTMLElement | null, state: { moving: boolean; zoom: number }): void {
  if (!stage) return
  stage.toggleAttribute('data-canvas-moving', state.moving)
  stage.toggleAttribute('data-canvas-far', isFarZoom(state.zoom))
}
