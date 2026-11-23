import type { Overrides } from '../keys'
import { useStore } from '../store'

/** The bound keys, kept up to date when they're rebound in Settings. */
export function useKeyOverrides(): Overrides {
  return useStore((s) => s.keyOverrides)
}
