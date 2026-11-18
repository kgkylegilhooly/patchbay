import { create } from 'zustand'
import type { Point } from './menus'

/** Which recipe dialog is open. Kept apart from the canvas store, so recipes add no state to it. */
export const useRecipeUi = create<{ picker: { at?: Point } | null; saving: boolean }>(() => ({ picker: null, saving: false }))

export const openRecipePicker = (at?: Point): void => useRecipeUi.setState({ picker: { at }, saving: false })
export const openRecipeSave = (): void => useRecipeUi.setState({ picker: null, saving: true })
export const closeRecipes = (): void => useRecipeUi.setState({ picker: null, saving: false })
