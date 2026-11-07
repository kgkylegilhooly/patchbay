import type { WorkBridge } from '../shared/git'

declare global {
  interface Window {
    patchbayWork: WorkBridge
  }
}

/** The git panel's and the board's calls to main. */
export const work: WorkBridge = window.patchbayWork
