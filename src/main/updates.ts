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
  /** Installs the downloaded update and starts the new version. The caller has already shut down. */
  install(): void
  onChange(cb: (s: UpdateState) => void): void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300)

export function createUpdates({
  updater,
  feed,
  packaged,
  now = Date.now
}: {
  updater: Updater
  /** Read at each check, so a saved change applies without a restart. */
  feed: () => string | undefined
  packaged: boolean
  now?: () => number
}): Updates {
  let state: UpdateState = { phase: 'idle' }
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
  updater.on('update-downloaded', (info: { version: string }) => set({ phase: 'ready', version: info.version }))
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
    install() {
      updater.quitAndInstall(true, true)
    },
    onChange(cb) {
      listeners.push(cb)
    }
  }
}
