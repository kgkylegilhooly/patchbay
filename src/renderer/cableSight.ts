import { alignCableDots } from './cableActivity'

/**
 * A busy cable's dots stop while the cable is off screen. They step twelve times a second, and Chromium still restyles
 * and repaints an animated path nobody can see: a canvas zoomed in on one corner kept every busy cable elsewhere
 * stepping. One IntersectionObserver watches every one-way cable's dots; off screen they get a `data-off` attribute,
 * which pauses them (nodes/cablePerf.css, imported by CableEdge), and back on screen they go on the beat every other
 * cable steps to.
 *
 * An attribute, not a class: React owns the path's class (cable-still or not) and writes it whole when the cable turns
 * busy, which wiped a class added here, and the observer, seeing no change in sight, never put it back.
 */
export const OFF = 'data-off'

/** What this needs of an element, so a test can stand in for one. */
export interface Sighted {
  toggleAttribute(name: string, on: boolean): unknown
  hasAttribute(name: string): boolean
  getAnimations?: () => Array<{ playState: string; startTime: CSSNumberish | null }>
}

/** Marks each cable on or off screen. One coming back on screen joins the others' beat. */
export function applySight(entries: Array<{ target: Sighted; isIntersecting: boolean }>): void {
  for (const { target, isIntersecting } of entries) {
    const wasOff = target.hasAttribute(OFF)
    target.toggleAttribute(OFF, !isIntersecting)
    if (isIntersecting && wasOff) alignCableDots(target)
  }
}

let observer: IntersectionObserver | null = null

/** Watches a cable's dots until the returned function is called. */
export function watchCableSight(el: Element | null): () => void {
  if (!el || typeof IntersectionObserver === 'undefined') return () => {}
  observer ??= new IntersectionObserver((entries) => applySight(entries as unknown as Array<{ target: Sighted; isIntersecting: boolean }>))
  observer.observe(el)
  return () => {
    observer?.unobserve(el)
    el.removeAttribute(OFF)
  }
}
