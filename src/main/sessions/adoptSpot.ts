import { placeInProject, type Point, type Rect, type Size } from '../../core/canvas/place'
import type { CanvasDoc } from '../../shared/model'

/** A recovered session's window: a terminal's usual size. */
export const ADOPT_SIZE: Size = { width: 560, height: 340 }

/**
 * Where a session with no node is shown when adopted: placed as any node nothing opened is, the nearest free spot to
 * the middle of what the person sees (the safe area the page reports), so it never lands on top of other nodes.
 */
export function adoptSpot(doc: CanvasDoc, screen: Size | Rect | null): Point {
  return placeInProject(doc, doc.activeProjectId, ADOPT_SIZE, screen)
}
