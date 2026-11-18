import type { RecipeBridge } from '../shared/recipe'

declare global {
  interface Window {
    patchbayRecipes: RecipeBridge
  }
}

/** The recipe picker's and save dialog's calls to main. */
export const recipes: RecipeBridge = window.patchbayRecipes
