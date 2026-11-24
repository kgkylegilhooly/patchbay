import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import { join } from 'node:path'
import { hungWindowDetail, lowMemoryNote } from './stuckParts'
import type { App, BrowserWindow, Dialog, IpcMain, RenderProcessGoneDetails } from 'electron'

/** Past this the log starts again, keeping the one before as patchbay.1.log. */
const LOG_MAX_BYTES = 1024 * 1024
/**
 * The main process checks it isn't stuck this often, and notes any stall longer than STALL_MS. A stall is measured as
 * how late a check comes, so checking once per STALL_MS still notes every one, with half the wake-ups.
 */
const TICK_MS = 1000
export const STALL_MS = 1000
/**
 * A check this late means the PC was asleep or the process suspended, not that work held it: nothing in Patchbay holds
 * the main process for a minute. Windows' Modern Standby can sleep without the suspend event, so length alone counts.
 */
export const ASLEEP_MS = 60_000
/** How often memory goes in the log, so a slow leak over a long day shows. */
const MEMORY_EVERY_MS = 30 * 60_000
/** Crashes this close together stop the automatic reload, so a window that dies on load doesn't loop forever. */
const CRASH_WINDOW_MS = 2 * 60_000
const CRASHES_BEFORE_ASKING = 3

export interface Heartbeat {
  /** How often the window is pinged. */
  everyMs: number
  /** No answer for this long and it's taken to be stuck. Generous, so a heavy moment isn't mistaken for a hang. */
  hungAfterMs: number
}
export const HEARTBEAT: Heartbeat = { everyMs: 2000, hungAfterMs: 10_000 }

export interface Log {
  write(line: string): void
  file: string
  /** Waits for what's queued, as before quitting. */
  flush(): Promise<void>
}

/** A small rolling log under the data folder. Writes never block, and a failed one is dropped. */
export function createLog(dir: string, now: () => Date = () => new Date()): Log {
  const file = join(dir, 'patchbay.log')
  let chain: Promise<void> = mkdir(dir, { recursive: true }).then(
    () => undefined,
    () => undefined
  )
  const write = async (text: string): Promise<void> => {
    const size = await stat(file).then(
      (s) => s.size,
      () => 0
    )
    if (size > LOG_MAX_BYTES) await rename(file, join(dir, 'patchbay.1.log')).catch(() => {})
    await appendFile(file, text)
  }
  return {
    file,
    write(line) {
      const text = `${now().toISOString()} ${line.replace(/\s*\n\s*/g, ' ')}\n`
      chain = chain.then(() => write(text)).catch(() => {})
    },
    flush: () => chain
  }
}

/**
 * Notes each time the main process was stuck for longer than STALL_MS. Everything in Patchbay goes through it, so a
 * stall there is a stall everywhere. `onStall` is told how long it lasted, and when the check before it ran, so the work
 * started in between can be named (see workLog.ts).
 */
export function watchEventLoop(
  onStall: (ms: number, since: number) => void,
  tickMs = TICK_MS,
  now: () => number = () => Date.now(),
  sleep: {
    /** Told instead of onStall when the gap was a sleep. */
    onAsleep?: (ms: number) => void
    /** Whether the PC announced a suspend since the last check, clearing that. */
    slept?: () => boolean
  } = {}
): () => void {
  let last = now()
  const timer = setInterval(() => {
    const at = now()
    const late = at - last - tickMs
    const since = last
    last = at
    // Asked every time, so a suspend heard during an ordinary tick doesn't carry over to a later stall.
    const slept = sleep.slept?.() ?? false
    if (late < STALL_MS) return
    if (slept || late >= ASLEEP_MS) sleep.onAsleep?.(late)
    else onStall(late, since)
  }, tickMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** A sleep, for the log: in seconds, minutes or hours, as suits its length. */
export function asleepText(ms: number): string {
  const how = ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1)} h`
  return `Nothing ran for ${how}: the PC was asleep, or Patchbay was suspended. Not a stall.`
}

/** Whether to reload after a crash, given the times of recent crashes, oldest first. */
export function shouldAutoReload(crashTimes: number[], now: number): boolean {
  return crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).length < CRASHES_BEFORE_ASKING
}

const mb = (kb: number): number => Math.round(kb / 1024)

/** Memory in use by each kind of process, in MB, for the log. */
export function memorySummary(app: Pick<App, 'getAppMetrics'>): string {
  const byType = new Map<string, number>()
  for (const m of app.getAppMetrics()) byType.set(m.type, (byType.get(m.type) ?? 0) + (m.memory?.workingSetSize ?? 0))
  return [...byType].map(([type, kb]) => `${type} ${mb(kb)} MB`).join(', ')
}

export interface WindowWatch {
  /** For the app's own quit: the window closing on purpose isn't a crash. */
  dispose(): void
}

/**
 * Keeps the app window usable. Sessions run in the background host, not in the window, so reloading the window loses
 * nothing: terminals and agents carry on and the canvas comes back as it was.
 *
 * - The window stops answering: a dialog says the sessions are safe and offers to reload it, and goes away by itself
 *   if the window recovers. A stuck page can't reload itself, so its process is ended first.
 * - The window's process crashes or is killed: it's reloaded, unless that keeps happening, when the person is asked.
 *
 * Electron says a window is unresponsive only when real input is waiting on it, so a hang while nobody is typing went
 * unseen. A heartbeat covers that: the window answers a ping every couple of seconds from its own main thread, which a
 * stuck page can't do.
 */
export function watchWindow(
  win: BrowserWindow,
  deps: { dialog: Pick<Dialog, 'showMessageBox'>; log: Log; app: Pick<App, 'getAppMetrics' | 'quit'>; ipcMain?: Pick<IpcMain, 'on' | 'removeListener'>; heartbeat?: Partial<Heartbeat> }
): WindowWatch {
  const { dialog, log, app } = deps
  const beat = { ...HEARTBEAT, ...deps.heartbeat }
  let hungSince: number | null = null
  let asking: AbortController | null = null
  let reloadingOnPurpose = false
  let disposed = false
  const crashes: number[] = []

  // A reload sent to a stuck page is lost with it, so its process is ended first and the reload waits for that to
  // finish, in the render-process-gone handler below.
  const reload = (): void => {
    if (win.isDestroyed()) return
    reloadingOnPurpose = true
    win.webContents.forcefullyCrashRenderer()
  }

  // The heartbeat. Nothing counts until a page has loaded, nor while one loads, nor across the PC sleeping.
  let lastPong: number | null = null
  let lastTick = Date.now()
  let seq = 0
  const onPong = (e: { sender: unknown }): void => {
    if (e.sender !== win.webContents) return
    lastPong = Date.now()
    if (hungSince !== null) recovered()
  }
  deps.ipcMain?.on('pb:pong', onPong)
  win.webContents.on('did-finish-load', () => {
    lastPong = Date.now()
  })
  win.webContents.on('did-start-loading', () => {
    lastPong = null
  })
  const ticker = setInterval(() => {
    const now = Date.now()
    const slept = now - lastTick > beat.everyMs * 3
    lastTick = now
    if (disposed || win.isDestroyed() || lastPong === null) return
    // Hidden in the tray, nobody can see it hang, so it isn't pinged: the beat starts afresh once it shows again.
    const hidden = typeof win.isVisible === 'function' && !win.isVisible()
    if (slept || hidden) lastPong = now
    if (hidden) return
    win.webContents.send('pb:ping', ++seq)
    if (hungSince === null && now - lastPong >= beat.hungAfterMs) hung('no answer to the heartbeat')
  }, beat.everyMs)
  ticker.unref?.()

  const hung = (how: string): void => {
    if (disposed || hungSince !== null) return
    hungSince = Date.now()
    const memoryNote = lowMemoryNote(freemem(), totalmem())
    log.write(`The window stopped responding (${how}). Memory: ${memorySummary(app)}, ${Math.round(freemem() / 1048576)} MB free on the PC.`)
    asking = new AbortController()
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        title: 'Patchbay',
        message: "Patchbay's window isn't responding",
        detail: hungWindowDetail(memoryNote),
        buttons: ['Reload window', 'Keep waiting'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        signal: asking.signal
      })
      .then(({ response }) => {
        if (response !== 0 || hungSince === null) return
        log.write('Reloading the window, as asked.')
        hungSince = null
        reload()
      })
      .catch(() => {})
  }

  const recovered = (): void => {
    if (hungSince === null) return
    log.write(`The window recovered after ${Math.round((Date.now() - hungSince) / 1000)} s.`)
    hungSince = null
    asking?.abort()
    asking = null
  }

  win.on('unresponsive', () => hung('Electron noticed'))
  win.on('responsive', recovered)

  win.webContents.on('render-process-gone', (_e, details: RenderProcessGoneDetails) => {
    if (disposed) return
    hungSince = null
    lastPong = null
    asking?.abort()
    asking = null
    if (reloadingOnPurpose) {
      // Ended on purpose, to reload a stuck window: not a crash.
      reloadingOnPurpose = false
      win.webContents.reload()
      return
    }
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    crashes.push(now)
    log.write(`The window's process ended (${details.reason}, exit code ${details.exitCode}). Memory: ${memorySummary(app)}`)
    if (shouldAutoReload(crashes, now)) {
      log.write('Reloading the window.')
      win.webContents.reload()
      return
    }
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Patchbay',
        message: "Patchbay's window keeps stopping",
        detail: `It stopped ${crashes.length} times in the last few minutes (${details.reason}). Your terminals and agents are still running in the background. The log in Patchbay's data folder says what happened.`,
        buttons: ['Reload window', 'Quit Patchbay'],
        defaultId: 0,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 0 && !win.isDestroyed()) win.webContents.reload()
        else app.quit()
      })
      .catch(() => {})
  })

  return {
    dispose() {
      disposed = true
      clearInterval(ticker)
      deps.ipcMain?.removeListener('pb:pong', onPong)
      asking?.abort()
    }
  }
}

/** Notes memory in the log now and then, for spotting a slow leak over a long day. */
export function logMemoryNowAndThen(app: Pick<App, 'getAppMetrics'>, log: Log, everyMs = MEMORY_EVERY_MS): () => void {
  const timer = setInterval(() => log.write(`Memory: ${memorySummary(app)}`), everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
