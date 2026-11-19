import { ipcMain } from 'electron'
import { readIfPresentSync, writeAtomic } from '../core/persist/atomicFile'
import { migratedSettingsText, withProfiles } from '../shared/terminalProfiles'
import { parseSettings } from './lifecycle'
import { terminalProfiles } from './sessions/shell'

/** Serves `pb:terminalProfiles:*`, the settings page's and the new-terminal menus' channels. See src/preload/terminalProfiles.ts. */
export function registerTerminalProfileIpc({ settingsFile, log }: { settingsFile: string; log?: (line: string) => void }): void {
  // An old `shell` setting becomes a saved profile now, before anything else writes the file.
  const migrated = migratedSettingsText(readIfPresentSync(settingsFile))
  if (migrated !== null) void writeAtomic(settingsFile, migrated).catch((e: unknown) => log?.(`Saving the shell setting as a terminal profile failed: ${String(e)}`))

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
