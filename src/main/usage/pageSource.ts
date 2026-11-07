import { BrowserWindow, session } from 'electron'
import { readFromText } from './pageText'
import { checkUrl, type ReadResult, type SourceConfig } from './usageSource'

const PARTITION = 'persist:usage'
const LOAD_LIMIT_MS = 30_000
/** Pages that fetch their numbers draw them after they load. */
const SETTLE_LIMIT_MS = 15_000
const SETTLE_STEP_MS = 1000
const SCRIPT_LIMIT_MS = 5000

let signIn: BrowserWindow | null = null
let locked = false

/** This window only shows someone else's page: no preload, no Node, and nothing it can ask the PC for. */
function pageWindow(show: boolean): BrowserWindow {
  const ses = session.fromPartition(PARTITION)
  if (!locked) {
    locked = true
    ses.setPermissionRequestHandler((_web, _permission, answer) => answer(false))
    ses.on('will-download', (e) => e.preventDefault())
  }
  const win = new BrowserWindow({
    show,
    width: 960,
    height: 720,
    title: 'Sign in',
    backgroundColor: '#ffffff',
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Loads the page hidden, using the saved sign-in, and looks for the amounts in its text. */
export async function readPage(cfg: SourceConfig): Promise<ReadResult> {
  const bad = checkUrl(cfg.url)
  if (bad) return { ok: false, problem: bad }
  const limit = { fixed: cfg.fixedLimit, pattern: cfg.limitPattern }
  const unusable = readFromText('', cfg.usedPattern ?? '', limit)
  if (!cfg.usedPattern || (cfg.fixedLimit === undefined && !cfg.limitPattern)) return unusable

  const win = pageWindow(false)
  try {
    const loaded = win.loadURL(cfg.url).then(
      () => true,
      () => false
    )
    const opened = await Promise.race([loaded, sleep(LOAD_LIMIT_MS).then(() => false)])
    if (!opened) return { ok: false, problem: "The page didn't open." }

    let last: ReadResult = { ok: false, problem: 'The page had no text.' }
    const deadline = Date.now() + SETTLE_LIMIT_MS
    while (Date.now() < deadline && !win.isDestroyed()) {
      const hung = Symbol('hung')
      const text: unknown = await Promise.race([win.webContents.executeJavaScript('document.body ? document.body.innerText : ""'), sleep(SCRIPT_LIMIT_MS).then(() => hung)])
      if (text === hung) return { ok: false, problem: "The page isn't responding." }
      last = readFromText(typeof text === 'string' ? text : '', cfg.usedPattern, limit)
      if (last.ok) return last
      // Waiting won't help a pattern that can't run, and the answer is already known.
      if (/isn't valid|took too long|round brackets|isn't an amount/.test(last.problem)) return last
      if (hostOf(win.webContents.getURL()) !== hostOf(cfg.url)) return { ok: false, problem: 'Sign in again: the page went to another site.' }
      await sleep(SETTLE_STEP_MS)
    }
    return last
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** A visible window on the same saved sign-in, so single sign-on works the way it does in a browser. */
export function openUsageSignIn(url: string): string | null {
  const bad = checkUrl(url)
  if (bad) return bad
  if (signIn && !signIn.isDestroyed()) {
    signIn.focus()
    return null
  }
  signIn = pageWindow(true)
  signIn.on('closed', () => {
    signIn = null
  })
  void signIn.loadURL(url).catch(() => {})
  return null
}
