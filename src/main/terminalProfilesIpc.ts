import { ipcMain } from 'electron'
import { readIfPresentSync, writeAtomic } from '../core/persist/atomicFile'
import { withProfiles } from '../shared/terminalProfiles'
import { parseSettings } from './lifecycle'
import { terminalProfiles } from './sessions/shell'

/** Serves `pb:terminalProfiles:*`, the settings page's and the new-terminal menus' channels. See src/preload/terminalProfiles.ts. */
export function registerTerminalProfileIpc({ settingsFile }: { settingsFile: string }): void {
  const list = () => terminalProfiles(parseSettings(readIfPresentSync(settingsFile)))
  ipcMain.handle('pb:terminalProfiles:list', () => list())
  ipcMain.handle('pb:terminalProfiles:save', async (_e, profiles: unknown, defaultId: unknown) => {
    if (!Array.isArray(profiles) || typeof defaultId !== 'string') return { ok: false, reason: 'Those profiles could not be read.' }
    const text = withProfiles(readIfPresentSync(settingsFile), profiles, defaultId)
    if (text === null) return { ok: false, reason: 'settings.json has a mistake in it, so saving would overwrite it. Fix it with Open file, under About, then try again.' }
    await writeAtomic(settingsFile, text)
    return { ok: true, list: list() }
  })
}
