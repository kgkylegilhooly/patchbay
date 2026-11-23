import type { Updater } from './updates'

/**
 * electron-updater, loaded the first time it's asked to do something. Loading it (with fs-extra, js-yaml and
 * builder-util-runtime) took about 70 ms of every start, before the window, though the first update check is minutes
 * later and a dev copy never checks. Settings and listeners given before then are handed on, in order, when it loads.
 */
export function lazyUpdater(load: () => Updater): Updater {
  let real: Updater | null = null
  const waiting: Array<(u: Updater) => void> = []
  const settings = { autoDownload: false, autoInstallOnAppQuit: true }
  const now = (): Updater => {
    if (!real) {
      real = load()
      for (const apply of waiting.splice(0)) apply(real)
    }
    return real
  }
  const later = (apply: (u: Updater) => void): void => {
    if (real) apply(real)
    else waiting.push(apply)
  }
  return {
    get autoDownload() {
      return real ? real.autoDownload : settings.autoDownload
    },
    set autoDownload(on: boolean) {
      settings.autoDownload = on
      later((u) => (u.autoDownload = on))
    },
    get autoInstallOnAppQuit() {
      return real ? real.autoInstallOnAppQuit : settings.autoInstallOnAppQuit
    },
    set autoInstallOnAppQuit(on: boolean) {
      settings.autoInstallOnAppQuit = on
      later((u) => (u.autoInstallOnAppQuit = on))
    },
    on(event, cb) {
      later((u) => u.on(event, cb))
      return undefined
    },
    setFeedURL: (feed) => now().setFeedURL(feed),
    checkForUpdates: () => now().checkForUpdates(),
    quitAndInstall: (isSilent, isForceRunAfter) => now().quitAndInstall(isSilent, isForceRunAfter)
  }
}
