import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateState } from '../shared/contract'

export type UpdateFeed = { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string }

/**
 * Where updates come from, as Settings has it: `github:owner/repo` for GitHub releases, or an https address that
 * holds latest.yml. A plain http address is only allowed for this PC itself, to test a local feed.
 */
export function parseFeed(text: string | undefined): UpdateFeed | null {
  const t = (text ?? '').trim()
  if (!t) return null
  const gh = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(t)
  if (gh) return { provider: 'github', owner: gh[1], repo: gh[2] }
  let url: URL
  try {
    url = new URL(t)
  } catch {
    return null
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  return { provider: 'generic', url: url.href.replace(/\/?$/, '/') }
}

/** The parts of electron-updater's AppUpdater used here, so tests can stand in for it. */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(feed: UpdateFeed): void
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'checking-for-update' | 'update-available' | 'update-not-available' | 'download-progress' | 'update-downloaded' | 'error', cb: (arg: never) => void): unknown
}

export interface Updates {
  state(): UpdateState
  /** Asks the feed now. Does nothing while a check or download is already under way. */
  check(): Promise<void>
  /** True if an update is downloaded and waiting for Restart to update. */
  ready(): boolean
  /**
   * Whether the downloaded installer has gone from disk since (antivirus software removes some). Asked before any
   * session ends: electron-updater would quit the app anyway and start nothing. When gone, the update is an error.
   */
  installerGone(): boolean
  /**
   * Installs the downloaded update and starts the new version. The caller has already shut down. False when
   * electron-updater couldn't start it, which it reports as an error instead of quitting.
   */
  install(): boolean
  onChange(cb: (s: UpdateState) => void): void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300)

export function createUpdates({
  updater,
  feed,
  packaged,
  now = Date.now,
  exists = existsSync,
  initial = { phase: 'idle' }
}: {
  updater: Updater
  exists?: (path: string) => boolean
  /** A failure from the last run's Restart to update (takeUpdateFailure), shown until the next check. */
  initial?: UpdateState
  /** Read at each check, so a saved change applies without a restart. */
  feed: () => string | undefined
  packaged: boolean
  now?: () => number
}): Updates {
  let state: UpdateState = initial
  /** The downloaded installer, as update-downloaded names it. */
  let installer: string | undefined
  const listeners: Array<(s: UpdateState) => void> = []
  const set = (next: UpdateState): void => {
    state = next
    for (const cb of listeners) cb(state)
  }
  // Downloads start by themselves, so Restart to update is all that's left to do. Nothing installs without it.
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = false
  updater.on('checking-for-update', () => set({ phase: 'checking' }))
  updater.on('update-available', (info: { version: string }) => set({ phase: 'downloading', version: info.version, percent: 0 }))
  updater.on('update-not-available', () => set({ phase: 'none', checkedAt: now() }))
  updater.on('download-progress', (p: { percent: number }) => {
    if (state.phase === 'downloading') set({ ...state, percent: Math.round(p.percent) })
  })
  updater.on('update-downloaded', (info: { version: string; downloadedFile?: string }) => {
    installer = typeof info.downloadedFile === 'string' ? info.downloadedFile : undefined
    set({ phase: 'ready', version: info.version })
  })
  updater.on('error', (e: Error) => set({ phase: 'error', message: message(e) }))

  return {
    state: () => state,
    ready: () => state.phase === 'ready',
    async check() {
      if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready') return
      if (!packaged) return set({ phase: 'off', reason: 'Updates only work in the installed app.' })
      const parsed = parseFeed(feed())
      if (!parsed) return set({ phase: 'off', reason: feed()?.trim() ? "That update feed isn't valid." : 'No update feed is set.' })
      updater.setFeedURL(parsed)
      try {
        await updater.checkForUpdates()
      } catch (e) {
        set({ phase: 'error', message: message(e) })
      }
    },
    installerGone() {
      if (state.phase !== 'ready' || !installer || exists(installer)) return false
      set({ phase: 'error', install: true, message: "The downloaded update is no longer on disk, so it wasn't installed and nothing was stopped. Security software may have removed it. Check now to download it again." })
      return true
    },
    install() {
      try {
        updater.quitAndInstall(true, true)
      } catch (e) {
        set({ phase: 'error', message: message(e) })
      }
      // electron-updater reports a failure to start the installer as an error event, at once, and then doesn't quit.
      if (state.phase !== 'error') return true
      set({ phase: 'error', install: true, message: `The update didn't install: ${state.message}` })
      return false
    },
    onChange(cb) {
      listeners.push(cb)
    }
  }
}

/** Where a failed install is noted, so the relaunched app can say why it's still the old version. */
const failureFile = (dir: string): string => join(dir, 'update-failed.json')

export function noteUpdateFailure(dir: string, reason: string): void {
  try {
    writeFileSync(failureFile(dir), JSON.stringify({ reason }))
  } catch (e) {
    console.error('Patchbay could not note the failed update:', e)
  }
}

/** The last run's failed install, once: the note is removed as it's read. */
export function takeUpdateFailure(dir: string): UpdateState | undefined {
  let reason: unknown
  try {
    reason = (JSON.parse(readFileSync(failureFile(dir), 'utf8')) as { reason?: unknown }).reason
  } catch {
    // Missing, or unreadable: either way it's not shown, and a broken one isn't kept.
    rmSync(failureFile(dir), { force: true })
    return undefined
  }
  rmSync(failureFile(dir), { force: true })
  if (typeof reason !== 'string') return undefined
  return { phase: 'error', install: true, message: `${reason.slice(0, 300)} Patchbay restarted as it was, and your sessions resumed.` }
}
