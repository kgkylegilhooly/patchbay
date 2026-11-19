import type { CompareBridge } from '../shared/compare'

declare global {
  interface Window {
    patchbayCompare: CompareBridge
  }
}

/** The comparison dialog's and view's calls to main. */
export const compare: CompareBridge = window.patchbayCompare
