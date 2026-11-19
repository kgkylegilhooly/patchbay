import { contextBridge, ipcRenderer } from 'electron'
import type { RecipeBridge } from '../shared/recipe'

/** Every method is one request on the channel `pb:recipes:<method>`, served in src/main/recipes/ipc.ts. */
const call =
  (name: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(`pb:recipes:${name}`, ...args) as Promise<never>

const names: (keyof RecipeBridge)[] = ['list', 'start', 'save', 'startAnyway', 'openRecipesFolder']

export function exposeRecipes(): void {
  contextBridge.exposeInMainWorld('patchbayRecipes', Object.fromEntries(names.map((n) => [n, call(n)])))
}
