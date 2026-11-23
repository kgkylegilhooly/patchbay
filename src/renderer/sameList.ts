import { useRef } from 'react'

/** Whether two lists hold the same items in the same order. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The list from before when the new one holds the same items, else the new one. */
export function keepSame<T>(prev: T[] | undefined, next: T[]): T[] {
  return prev && sameItems(prev, next) ? prev : next
}

/**
 * The list from the last render while its items stay the same. The selection is worked out again on every frame of a
 * drag, and a new array each time would render whatever it's given, though nothing selected changed.
 */
export function useSameList<T>(next: T[]): T[] {
  const kept = useRef<T[] | undefined>(undefined)
  kept.current = keepSame(kept.current, next)
  return kept.current
}
