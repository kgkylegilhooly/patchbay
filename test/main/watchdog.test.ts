import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ASLEEP_MS, asleepText, createLog, shouldAutoReload, STALL_MS, watchEventLoop, watchWindow } from '../../src/main/watchdog'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay watchdog '))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

test('the log writes stamped lines in order, one per line, and makes its folder', async () => {
  const log = createLog(join(dir, 'logs'), () => new Date('2026-11-17T10:00:00Z'))
  log.write('first')
  log.write('second\nwith a break')
  await log.flush()
  expect(readFileSync(log.file, 'utf8')).toBe('2026-11-17T10:00:00.000Z first\n2026-11-17T10:00:00.000Z second with a break\n')
})

test('the log starts again past 1 MB, keeping the one before', async () => {
  const log = createLog(dir)
  writeFileSync(log.file, 'x'.repeat(1024 * 1024 + 10))
  log.write('fresh')
  await log.flush()
  expect(readFileSync(log.file, 'utf8')).toMatch(/fresh\n$/)
  expect(readFileSync(log.file, 'utf8').length).toBeLessThan(100)
  expect(existsSync(join(dir, 'patchbay.1.log'))).toBe(true)
})

test('a stalled main process is noted with how long it was stuck; an ordinary tick is not', () => {
  vi.useFakeTimers()
  let now = 0
  const stalls: number[] = []
  const stop = watchEventLoop((ms) => stalls.push(ms), 500, () => now)
  now += 500
  vi.advanceTimersByTime(500)
  // The next tick comes 3 s late, as after a blocking call.
  now += 3500
  vi.advanceTimersByTime(500)
  stop()
  expect(stalls).toEqual([3000])
  expect(STALL_MS).toBe(1000)
})

// The real log had "blocked for 39254.9 s" overnight: the PC asleep, not the app stuck.
test('a gap the length of a sleep, or one that follows a suspend, is noted as a sleep, not a stall', () => {
  vi.useFakeTimers()
  let now = 0
  let suspended = false
  const stalls: number[] = []
  const sleeps: number[] = []
  const stop = watchEventLoop((ms) => stalls.push(ms), 500, () => now, {
    onAsleep: (ms) => sleeps.push(ms),
    slept: () => {
      const was = suspended
      suspended = false
      return was
    }
  })
  // Eleven hours with nothing run, and no suspend heard of, as with Modern Standby.
  now += 11 * 3600_000 + 500
  vi.advanceTimersByTime(500)
  // A short sleep that Windows did announce.
  suspended = true
  now += 20_000 + 500
  vi.advanceTimersByTime(500)
  // Then a real stall, which is still one.
  now += 2500
  vi.advanceTimersByTime(500)
  stop()
  expect(sleeps).toEqual([11 * 3600_000, 20_000])
  expect(stalls).toEqual([2000])
  expect(ASLEEP_MS).toBe(60_000)
})

test('crashes reload by themselves until three come within two minutes', () => {
  expect(shouldAutoReload([0], 1000)).toBe(true)
  expect(shouldAutoReload([0, 1000], 2000)).toBe(true)
  expect(shouldAutoReload([0, 1000, 2000], 3000)).toBe(false)
  // Old ones don't count.
  expect(shouldAutoReload([0, 1000, 200_000], 200_500)).toBe(true)
})

function fakeWindow() {
  const win = new EventEmitter() as EventEmitter & Record<string, unknown>
  const contents = new EventEmitter() as EventEmitter & Record<string, unknown>
  contents.reload = vi.fn()
  contents.forcefullyCrashRenderer = vi.fn(() => contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 }))
  win.webContents = contents
  win.isDestroyed = () => false
  return { win, contents }
}

function setup(answer: number) {
  const { win, contents } = fakeWindow()
  const lines: string[] = []
  let signal: AbortSignal | undefined
  const dialog = {
    showMessageBox: vi.fn((_w: unknown, opts: { signal?: AbortSignal }) => {
      signal = opts.signal
      return Promise.resolve({ response: answer, checkboxChecked: false })
    })
  }
  const app = { getAppMetrics: () => [{ type: 'Tab', memory: { workingSetSize: 204800 } }], quit: vi.fn() }
  const log = { write: (l: string) => lines.push(l), file: '', flush: () => Promise.resolve() }
  watchWindow(win as never, { dialog: dialog as never, log, app: app as never })
  return { win, contents, dialog, lines, app, signal: () => signal }
}

test('a window that stops responding offers a reload, which ends the stuck page first and is not counted as a crash', async () => {
  const t = setup(0)
  t.win.emit('unresponsive')
  await Promise.resolve()
  await Promise.resolve()
  expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  expect(t.contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
  expect(t.contents.reload).toHaveBeenCalledTimes(1)
  expect(t.lines.join('\n')).toMatch(/stopped responding.*Tab 200 MB/)
  expect(t.lines.join('\n')).not.toMatch(/process ended/)
})

test('a window that recovers takes the question away, and says so in the log', async () => {
  const t = setup(1)
  t.win.emit('unresponsive')
  t.win.emit('unresponsive')
  expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  t.win.emit('responsive')
  expect(t.signal()?.aborted).toBe(true)
  expect(t.lines.some((l) => /recovered after/.test(l))).toBe(true)
  await Promise.resolve()
  expect(t.contents.reload).not.toHaveBeenCalled()
})

test('a crashed window reloads by itself, and asks instead once crashes repeat', async () => {
  const t = setup(1)
  for (let i = 0; i < 2; i++) t.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 })
  expect(t.contents.reload).toHaveBeenCalledTimes(2)
  expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  t.contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 })
  expect(t.contents.reload).toHaveBeenCalledTimes(2)
  expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  await Promise.resolve()
  // "Quit Patchbay" was the answer here.
  expect(t.app.quit).toHaveBeenCalled()
  expect(t.lines.filter((l) => /process ended/.test(l))).toHaveLength(3)
})

test('a clean exit, as when the app quits, is not a crash', () => {
  const t = setup(0)
  t.contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  expect(t.contents.reload).not.toHaveBeenCalled()
  expect(t.lines).toEqual([])
})

function heartbeatSetup() {
  vi.useFakeTimers()
  const { win, contents } = fakeWindow()
  contents.send = vi.fn()
  const ipcMain = new EventEmitter()
  const lines: string[] = []
  let signal: AbortSignal | undefined
  const dialog = {
    showMessageBox: vi.fn((_w: unknown, opts: { signal?: AbortSignal }) => {
      signal = opts.signal
      return new Promise(() => {})
    })
  }
  const app = { getAppMetrics: () => [], quit: vi.fn() }
  const log = { write: (l: string) => lines.push(l), file: '', flush: () => Promise.resolve() }
  const watch = watchWindow(win as never, { dialog: dialog as never, log, app: app as never, ipcMain: ipcMain as never, heartbeat: { everyMs: 1000, hungAfterMs: 5000 } })
  const pong = () => ipcMain.emit('pb:pong', { sender: contents }, 1)
  return { win, contents, ipcMain, dialog, lines, pong, watch, signal: () => signal }
}

test('a window hidden in the tray is not pinged, and is not taken to be stuck until it shows and stays silent', () => {
  const t = heartbeatSetup()
  let visible = false
  ;(t.win as Record<string, unknown>).isVisible = () => visible
  t.contents.emit('did-finish-load')
  vi.advanceTimersByTime(60_000)
  expect(t.contents.send).not.toHaveBeenCalled()
  expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  visible = true
  vi.advanceTimersByTime(1000)
  expect(t.contents.send).toHaveBeenCalledWith('pb:ping', expect.any(Number))
  expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  vi.advanceTimersByTime(6000)
  expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  t.watch.dispose()
})

test('a window that stops answering the heartbeat is taken to be stuck, with nobody typing', () => {
  const t = heartbeatSetup()
  t.contents.emit('did-finish-load')
  for (let i = 0; i < 3; i++) {
    vi.advanceTimersByTime(1000)
    t.pong()
  }
  expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  vi.advanceTimersByTime(5000)
  expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  expect(t.lines.join('\n')).toMatch(/stopped responding \(no answer to the heartbeat\)/)
  expect(t.contents.send).toHaveBeenCalledWith('pb:ping', expect.any(Number))
  // An answer at last: recovered, and the question goes.
  t.pong()
  expect(t.signal()?.aborted).toBe(true)
  expect(t.lines.some((l) => /recovered after/.test(l))).toBe(true)
  t.watch.dispose()
  expect(t.ipcMain.listenerCount('pb:pong')).toBe(0)
})

test('the heartbeat waits for a page, and ignores the PC sleeping and other windows', () => {
  const t = heartbeatSetup()
  // Nothing loaded yet: no answers expected.
  vi.advanceTimersByTime(20_000)
  expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  t.contents.emit('did-finish-load')
  t.pong()
  // The PC sleeps: the clock jumps a minute between two ticks, which is no hang.
  vi.setSystemTime(Date.now() + 60_000)
  vi.advanceTimersByTime(1000)
  expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  // An answer from some other window doesn't count.
  t.ipcMain.emit('pb:pong', { sender: {} }, 1)
  // A reload under way: nothing counts until it finishes.
  t.contents.emit('did-start-loading')
  vi.advanceTimersByTime(20_000)
  expect(t.dialog.showMessageBox).not.toHaveBeenCalled()
  t.watch.dispose()
})

test('a sleep reads in units that suit it, and says it is not a stall', () => {
  expect(asleepText(20_000)).toBe('Nothing ran for 20 s: the PC was asleep, or Patchbay was suspended. Not a stall.')
  expect(asleepText(2647_600)).toMatch(/^Nothing ran for 44 min:/)
  expect(asleepText(39254_900)).toMatch(/^Nothing ran for 10\.9 h:/)
})
