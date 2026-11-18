import { mkdirSync } from 'node:fs'
import { ipcMain, shell } from 'electron'
import { readRecipe, type RecipeParams } from '../../shared/recipe'
import type { RecipeService } from './service'
import type { SetupGate } from './setupGate'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Serves `pb:recipes:*`, the recipe picker's and save dialog's channels. See src/preload/recipes.ts. */
export function registerRecipeIpc({ service, setupGate }: { service: RecipeService; setupGate: SetupGate }): void {
  const handle = (name: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(`pb:recipes:${name}`, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }
  handle('list', (projectId: string) => service.list(String(projectId)))
  handle('start', async (a: { projectId: string; ref: string; params: RecipeParams; at?: { x: number; y: number } }) => {
    try {
      const at = a?.at && Number.isFinite(a.at.x) && Number.isFinite(a.at.y) ? { x: a.at.x, y: a.at.y } : undefined
      return await service.start({ projectId: String(a?.projectId), ref: String(a?.ref), params: a?.params, at })
    } catch (e) {
      return { ok: false, reason: message(e) }
    }
  })
  handle('save', async (a: { projectId: string; recipe: unknown; where: string; overwrite?: boolean }) => {
    try {
      // What the page sends is checked as any file would be, so only known fields reach the disk.
      const recipe = readRecipe(a?.recipe)
      return await service.save({ projectId: String(a?.projectId), recipe, where: a?.where === 'repository' ? 'repository' : 'personal', overwrite: a?.overwrite === true })
    } catch (e) {
      return { ok: false, reason: message(e) }
    }
  })
  handle('startAnyway', (id: string) => setupGate.startAnyway(String(id)))
  handle('openRecipesFolder', async (projectId: string, where: string) => {
    const dir = await service.folderFor(String(projectId), where === 'repository' ? 'repository' : 'personal')
    if (!dir) return
    mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  })
}
