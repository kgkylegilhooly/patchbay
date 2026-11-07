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
