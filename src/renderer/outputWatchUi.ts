import { create } from 'zustand'

declare global {
  interface Window {
    /** See src/preload/reply.ts. */
    patchbayOutputWatch?: {
      watch(nodeId: string, phrase: string): Promise<{ ok: true; phrase: string } | { ok: false; reason: string }>
      unwatch(nodeId: string): Promise<void>
      all(): Promise<Record<string, string>>
      onChange(cb: (all: Record<string, string>) => void): () => void
    }
  }
}

/**
 * Notify when it prints… (F41): which windows are waiting for a phrase, as main says, and the window whose box is open.
 * Kept apart from the canvas store. Main does the matching: src/main/outputWatch.ts.
 */
export const useOutputWatch = create<{ watches: Record<string, string>; asking: string | null }>(() => ({ watches: {}, asking: null }))

let started = false
/** Follows main's list from the first use on. */
export function followOutputWatches(): void {
  const api = window.patchbayOutputWatch
  if (started || !api) return
  started = true
  void api.all().then((watches) => useOutputWatch.setState({ watches }))
  api.onChange((watches) => useOutputWatch.setState({ watches }))
}

export const askOutputWatch = (nodeId: string): void => useOutputWatch.setState({ asking: nodeId })
export const closeOutputWatch = (): void => useOutputWatch.setState({ asking: null })
export const stopOutputWatch = (nodeId: string): void => void window.patchbayOutputWatch?.unwatch(nodeId)

/** A phrase as a menu shows it: quoted, and cut. */
export const phraseLabel = (phrase: string): string => `"${phrase.length > 30 ? `${phrase.slice(0, 29)}…` : phrase}"`
