import type { AgentStatus } from '../shared/model'

/**
 * When a one-way cable's dots move. They repaint the cable about twelve times a second, which on a canvas of cables
 * kept the GPU busy all the time though nothing changed. Now they move only while something along the cable is under
 * way: a node at either end starting, working, or queued to start after the other. Otherwise they stand still where
 * they are, still showing the way the cable runs, as does its arrowhead.
 */
const UNDER_WAY: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['starting', 'working', 'queued'])

export function cableUnderWay(from: AgentStatus | null | undefined, to: AgentStatus | null | undefined): boolean {
  return (!!from && UNDER_WAY.has(from)) || (!!to && UNDER_WAY.has(to))
}

/** The part of an element's animations this needs, so a test can stand in for one. */
interface Stepping {
  playState: string
  startTime: CSSNumberish | null
}

/**
 * Puts a cable's dots on the beat every other cable's dots step to. Each cable's animation otherwise counts from when
 * it last started moving, so cables that started at different times step at different moments, and ten of them
 * repaint ten times as often as one. Counting from the start of the page's timeline, they all step in the same frame.
 * A paused animation is left alone: it's in step with the rest when they all resume together.
 */
export function alignCableDots(el: { getAnimations?: () => Stepping[] } | null): void {
  for (const animation of el?.getAnimations?.() ?? []) if (animation.playState === 'running' && animation.startTime !== 0) animation.startTime = 0
}
