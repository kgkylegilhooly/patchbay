import { writeFile } from 'node:fs/promises'
import { homedir, release, userInfo, version as osVersion } from 'node:os'
import { join } from 'node:path'
import { app, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { diagnosticsText, logTail, type MemoryReading } from '../../core/diagnostics/report'
import type { CanvasStore, HostInfo } from '../../shared/contract'
import type { AboutInfo } from '../../shared/diagnostics'
import type { Settings } from '../../shared/settings'
import { inTestMode } from '../testPickers'
import { buildInfo } from './buildInfo'
import { agentPrograms, logFolder, outsideHooks, readLogEnd, sessionLines } from './collect'

/** The account's name, for redacting a home folder that doesn't end in it. */
function accountName(): string | null {
  try {
    return userInfo().username || null
  } catch {
    return null
  }
}

export function aboutInfo(): AboutInfo {
  return {
    version: app.getVersion(),
    build: buildInfo(),
    electron: process.versions.electron ?? '?',
    node: process.versions.node,
    chrome: process.versions.chrome ?? '?',
    os: `${osVersion()} ${release()} ${process.arch}`
  }
}

/**
 * Settings › About's versions and agent programs, Copy diagnostics and Open log folder, for the app's own window only, on
 * `pb:diagnostics:*`. See src/preload/diagnostics.ts and docs/plans/r5-diagnostics.md.
 */
export function setupDiagnostics(d: {
  dataDir: string
  store: CanvasStore
  host: { isRunning(id: string): boolean; info(): HostInfo; sessions?(): Array<{ id: string; running: boolean }> }
  status(id: string): string
  sessionDir: string
  settings(): Settings
  /** The resource monitor's latest reading. */
  memory(): MemoryReading | null
  logFile: string | null
  isAppUi(e: IpcMainInvokeEvent): boolean
}): void {
  const build = async (): Promise<string> => {
    const settings = d.settings()
    const nodes = d.store.get().nodes
    const home = homedir()
    const [agents, sessions, log, outside] = await Promise.all([
      agentPrograms(settings),
      sessionLines({ nodes, isRunning: (id) => d.host.isRunning(id), status: d.status, sessionDir: d.sessionDir, hosted: d.host.sessions?.() }),
      d.logFile ? readLogEnd(d.logFile) : Promise.resolve(''),
      outsideHooks({
        home,
        configDir: Object.entries(process.env).find(([k]) => k.toUpperCase() === 'CLAUDE_CONFIG_DIR')?.[1],
        folders: [...d.store.get().projects.map((p) => p.folder), ...nodes.flatMap((n) => (n.kind === 'claude' ? [n.cwd] : []))]
      })
    ])
    return diagnosticsText({
      about: aboutInfo(),
      at: new Date().toISOString(),
      agents,
      launch: { claudeTerminal: settings.claudeTerminal, claudeCommand: settings.claudeCommand, codexCommand: settings.codexCommand },
      host: d.host.info(),
      sessions,
      memory: d.memory(),
      outsideHooks: outside,
      log: logTail(log, 40),
      home,
      user: accountName()
    })
  }

  ipcMain.handle('pb:diagnostics:about', (e) => (d.isAppUi(e) ? aboutInfo() : null))
  ipcMain.handle('pb:diagnostics:agents', (e) => (d.isAppUi(e) ? agentPrograms(d.settings()) : []))
  ipcMain.handle('pb:diagnostics:copy', async (e) => {
    if (!d.isAppUi(e)) return { ok: false, reason: 'Not available here.' }
    try {
      const text = await build()
      // A test or screenshot run shares the desktop with the person, so it leaves their clipboard alone.
      if (inTestMode()) await writeFile(join(d.dataDir, 'diagnostics-copied.txt'), text)
      else clipboard.writeText(text)
      return { ok: true, lines: text.split('\n').length }
    } catch (err) {
      return { ok: false, reason: `Couldn't gather them: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
  ipcMain.handle('pb:diagnostics:openLogFolder', async (e) => {
    // A folder window would open in front of the person.
    if (!d.isAppUi(e) || !d.logFile || inTestMode()) return
    await shell.openPath(logFolder(d.logFile))
  })
}
