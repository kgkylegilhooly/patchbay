import type { Session, WebContents, WebPreferences } from 'electron'
import { BROWSER_PARTITIONS, checkUrl, isAllowedSubframe, isAllowedSubresource, isAllowedTopLevel } from '../../shared/browserPolicy'

export type GuestNotice = (message: string) => void

/**
 * Settles what a browser node's page gets, whatever the app window asked for. No preload means no bridge, and a sandbox
 * with no Node means no way to the app, its files or its secret.
 */
export function lockAttach(prefs: WebPreferences & { preloadURL?: string }, params: Record<string, string>): boolean {
  if (!BROWSER_PARTITIONS.includes(params.partition ?? '')) return false
  delete prefs.preload
  delete prefs.preloadURL
  delete params.preload
  delete params.preloadURL
  delete params.plugins
  delete params.disablewebsecurity
  delete params.nodeintegration
  delete params.nodeintegrationinsubframes
  delete params.webpreferences
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.nodeIntegrationInWorker = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  prefs.webSecurity = true
  prefs.allowRunningInsecureContent = false
  prefs.experimentalFeatures = false
  prefs.webviewTag = false
  prefs.plugins = false
  // alert() and the like would otherwise raise a real window with the app's name on it, and stop the page until answered.
  prefs.disableDialogs = true
  prefs.partition = params.partition
  return true
}

/** Electron and the app name in the user agent tell every site what this is, and get some sites to turn it away. */
export function plainUserAgent(ua: string): string {
  return ua.replace(/\s(?:Electron|patchbay)\/\S+/gi, '')
}

/**
 * Set once per partition. Everything a page could ask of the browser is answered no here: no asking the person either,
 * because a prompt raised by a page an agent is driving is a poor question to put to them.
 */
export function lockSession(ses: Session, onBlocked: (contents: WebContents | null, message: string) => void, onRequest?: (details: { id: number; webContentsId?: number; url: string; method: string; resourceType?: string }) => void): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(false)
    const extra = permission === 'openExternal' ? ` (${(details as { externalURL?: string }).externalURL?.split(':')[0] ?? 'another program'})` : ''
    onBlocked(contents, `Blocked a request for ${permission === 'openExternal' ? 'another program' : permission}${extra}.`)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  ses.setSpellCheckerEnabled(false)
  ses.setUserAgent(plainUserAgent(ses.getUserAgent()))
  ses.on('will-download', (event, item, contents) => {
    event.preventDefault()
    onBlocked(contents, `Blocked a download: ${item.getFilename().slice(0, 80)}.`)
  })
  // The backstop, because it sees loads the navigation events don't, such as a <webview> src or a loadURL.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    onRequest?.(details)
    const allowed =
      details.resourceType === 'mainFrame'
        ? isAllowedTopLevel(details.url)
        : details.resourceType === 'subFrame'
          ? isAllowedSubframe(details.url)
          : isAllowedSubresource(details.url)
    callback(allowed ? {} : { cancel: true })
  })
}

/** Set on each page as it's created, before it loads anything. */
export function lockGuest(guest: WebContents, notice: GuestNotice): void {
  const blockTop = (e: { preventDefault(): void }, url: string): void => {
    if (isAllowedTopLevel(url)) return
    e.preventDefault()
    notice(`Refused to open ${url.split(':')[0]}: a browser node only opens http and https.`)
  }
  guest.on('will-navigate', (e) => blockTop(e, e.url))
  guest.on('will-redirect', (e) => blockTop(e, e.url))
  guest.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return blockTop(e, e.url)
    if (isAllowedSubframe(e.url)) return
    e.preventDefault()
    notice(`Refused a frame showing ${e.url.split(':')[0]}.`)
  })
  // Never a new window. What would have opened one opens here, under the same rules.
  guest.setWindowOpenHandler(({ url }) => {
    const checked = checkUrl(url)
    if (checked.ok) void guest.loadURL(checked.url).catch(() => {})
    else notice(`Refused a pop-up showing ${url.split(':')[0]}.`)
    return { action: 'deny' }
  })
  guest.on('will-attach-webview', (e) => e.preventDefault())
  guest.on('will-prevent-unload', (e) => e.preventDefault())
}
