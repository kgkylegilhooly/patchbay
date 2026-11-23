import type { AgentStatus } from '../shared/model'

/**
 * When a one-way cable's dots move. They repaint the cable about twelve times a second, which on a canvas of cables
 * kept the GPU busy all the time though nothing changed. Now they move only while something along the cable is under
 * way: an agent at either end starting, working, or queued to start after the other, or a run command at either end
 * running. Otherwise they stand still where they are, still showing the way the cable runs, as does its arrowhead.
 */
const UNDER_WAY: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['starting', 'working', 'queued'])

/** What a cable reads about the node at one end: an agent's status, and whether a run command is running. */
export interface CableEnd {
  status?: AgentStatus | null
  running?: boolean
}

export function endUnderWay(end: CableEnd): boolean {
  return !!end.running || (!!end.status && UNDER_WAY.has(end.status))
}

export function cableUnderWay(from: CableEnd, to: CableEnd): boolean {
  return endUnderWay(from) || endUnderWay(to)
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
 * A paused animation is left alone, since setting its start would set it going: alignCablesIn does those once the
 * view stops moving.
 */
export function alignCableDots(el: { getAnimations?: () => Stepping[] } | null): void {
  for (const animation of el?.getAnimations?.() ?? []) if (animation.playState === 'running' && animation.startTime !== 0) animation.startTime = 0
}

/**
 * Every moving cable's dots back on the beat. While the view moves or is zoomed far out every cable is paused, and one
 * that became busy meanwhile resumes on its own beat, so this runs when they resume.
 */
export function alignCablesIn(root: { querySelectorAll: (selector: string) => Iterable<{ getAnimations?: () => Stepping[] }> } | null): void {
  if (!root) return
  for (const el of root.querySelectorAll('.cable-flow:not(.cable-still)')) alignCableDots(el)
}
