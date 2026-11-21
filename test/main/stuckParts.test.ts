import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import { restartTogether, watchHungPage, type HungGuest } from '../../src/main/browser/hungPage'
import { hungPageNotice, hungWindowDetail, lowMemoryNote, processGoneText } from '../../src/main/stuckParts'

const MB = 1024 * 1024
const GB = 1024 * MB

test('a stopped graphics process is described as recovering by itself, with what to do if the window stays blank', () => {
  const text = processGoneText({ type: 'GPU', reason: 'crashed', exitCode: 5 })
  expect(text).toMatch(/^The graphics process stopped \(crashed, exit code 5\)/)
  expect(text).toMatch(/reload it/)
  expect(text).toMatch(/Terminals and agents were not affected/)
})

test('a stopped helper process is named by what it does', () => {
  expect(processGoneText({ type: 'Utility', reason: 'killed', exitCode: 1, name: 'Network Service', serviceName: 'network.mojom.NetworkService' })).toMatch(/^A helper process \(Network Service\) stopped/)
  expect(processGoneText({ type: 'Utility', reason: 'oom', exitCode: 1, serviceName: 'audio.mojom.AudioService' })).toMatch(/\(audio\.mojom\.AudioService\)/)
  expect(processGoneText({ type: 'Pepper Plugin', reason: 'crashed', exitCode: 2 })).toBe('A Pepper Plugin process stopped (crashed, exit code 2).')
})

test('low memory is mentioned only when Windows is actually short of it', () => {
  expect(lowMemoryNote(4 * GB, 16 * GB)).toBeNull()
  expect(lowMemoryNote(400 * MB, 16 * GB)).toMatch(/only 400 MB of memory free/)
  // Plenty of megabytes, but a small share of a big machine: the same line the resource notice uses.
  expect(lowMemoryNote(900 * MB, 64 * GB)).toMatch(/only 900 MB/)
  expect(lowMemoryNote(900 * MB, 8 * GB)).toBeNull()
  expect(lowMemoryNote(0, 0)).toBeNull()
})

test("the hung-window dialog says what's stuck, that sessions are safe, and adds a memory note when there is one", () => {
  const plain = hungWindowDetail(null)
  expect(plain).toMatch(/one page/)
  expect(plain).toMatch(/terminals and agents are safe/)
  expect(plain).not.toMatch(/memory/)
  expect(hungWindowDetail('Windows has only 300 MB of memory free.')).toMatch(/300 MB/)
})

class Guest extends EventEmitter implements HungGuest {
  destroyed = false
  loading = false
  /** Whether the page runs what it's sent. */
  answering = true
  crash = vi.fn(() => this.emit('render-process-gone', {}, { reason: 'killed' }))
  reload = vi.fn()
  asked = 0
  forcefullyCrashRenderer(): void {
    this.crash()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isLoading(): boolean {
    return this.loading
  }
  executeJavaScript(): Promise<unknown> {
    this.asked++
    return this.answering ? Promise.resolve(1) : new Promise(() => {})
  }
}

const quiet = { everyMs: 0, answerMs: 1500, reloadAnswerMs: 4000, restartWaitMs: 5000 }
const noop = () => ({ onHung: vi.fn(), onRecovered: vi.fn() })

test("Electron's own unresponsive and responsive events report a stuck page once, and its recovery", () => {
  const guest = new Guest()
  const d = noop()
  const page = watchHungPage(guest, d, quiet)
  guest.emit('unresponsive')
  guest.emit('unresponsive')
  expect(d.onHung).toHaveBeenCalledTimes(1)
  expect(page.hung).toBe(true)
  guest.emit('responsive')
  expect(d.onRecovered).toHaveBeenCalledTimes(1)
  expect(page.hung).toBe(false)
})

test('a page that answers is not stuck, so Reload is the usual one', async () => {
  const guest = new Guest()
  const page = watchHungPage(guest, noop(), quiet)
  expect(await page.stuck()).toBe(false)
  expect(guest.crash).not.toHaveBeenCalled()
})

test("Reload's check waits longer than the heartbeat, so a page that's only busy isn't ended", async () => {
  vi.useFakeTimers()
  try {
    const guest = new Guest()
    let answer: (v: unknown) => void = () => {}
    guest.executeJavaScript = () => new Promise((r) => (answer = r))
    const page = watchHungPage(guest, noop(), quiet)
    const stuck = page.stuck()
    await vi.advanceTimersByTimeAsync(2500)
    answer(1)
    expect(await stuck).toBe(false)
    guest.answering = false
    guest.executeJavaScript = Guest.prototype.executeJavaScript
    const really = page.stuck()
    await vi.advanceTimersByTimeAsync(4000)
    expect(await really).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

test('restarting a stuck page ends its process, then reloads it, and that ending is not a failure', async () => {
  const guest = new Guest()
  const d = noop()
  const page = watchHungPage(guest, d, quiet)
  let sawRestarting: boolean | null = null
  // The driver's own handler, added after the watcher, as in driver.ts.
  guest.on('render-process-gone', () => (sawRestarting = page.restarting))
  guest.emit('unresponsive')
  expect(await page.stuck()).toBe(true)
  expect(guest.asked).toBe(0)
  restartTogether(page, guest, [])
  expect(guest.crash).toHaveBeenCalledTimes(1)
  expect(sawRestarting).toBe(true)
  expect(d.onRecovered).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  expect(guest.reload).toHaveBeenCalledTimes(1)
  expect(page.restarting).toBe(false)
  expect(page.hung).toBe(false)
  // While a restart is under way, the page isn't counted as stuck again.
  expect(await page.stuck()).toBe(false)
})

test('pages sharing the stuck process restart with it: each reloads, and none reports a crash', async () => {
  // One renderer process: ending it ends every page in it.
  const guests = [new Guest(), new Guest(), new Guest()]
  const crashAll = () => guests.forEach((g) => g.emit('render-process-gone', {}, { reason: 'killed' }))
  guests[0].forcefullyCrashRenderer = crashAll
  const pages = guests.map((g) => watchHungPage(g, noop(), quiet))
  const failures: number[] = []
  guests.forEach((g, i) => g.on('render-process-gone', () => !pages[i].restarting && failures.push(i)))
  restartTogether(pages[0], guests[0], [pages[1], pages[2]])
  await Promise.resolve()
  expect(failures).toEqual([])
  expect(guests.map((g) => g.reload.mock.calls.length)).toEqual([1, 1, 1])
})

test("a restart whose process never reports ending still reloads, so Reload can't be stuck", async () => {
  vi.useFakeTimers()
  try {
    const guest = new Guest()
    guest.forcefullyCrashRenderer = () => {} // the ending never arrives
    const page = watchHungPage(guest, noop(), quiet)
    guest.emit('unresponsive')
    restartTogether(page, guest, [])
    expect(page.restarting).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(guest.reload).toHaveBeenCalledTimes(1)
    expect(page.restarting).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

test('the heartbeat notices a stuck page without any input, and its recovery, and skips pages still loading', async () => {
  vi.useFakeTimers()
  try {
    const guest = new Guest()
    const d = noop()
    const page = watchHungPage(guest, d, { everyMs: 5000, answerMs: 1500 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(guest.asked).toBe(1)
    expect(d.onHung).not.toHaveBeenCalled()
    guest.loading = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(guest.asked).toBe(1)
    guest.loading = false
    guest.answering = false
    await vi.advanceTimersByTimeAsync(5000 + 1500)
    expect(d.onHung).toHaveBeenCalledTimes(1)
    expect(page.hung).toBe(true)
    guest.answering = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(d.onRecovered).toHaveBeenCalledTimes(1)
    guest.emit('destroyed')
    const before = guest.asked
    await vi.advanceTimersByTimeAsync(20_000)
    expect(guest.asked).toBe(before)
  } finally {
    vi.useRealTimers()
  }
})

test('a page that crashes by itself is not reloaded by the watcher', async () => {
  const guest = new Guest()
  const page = watchHungPage(guest, noop(), quiet)
  guest.emit('unresponsive')
  guest.emit('render-process-gone', {}, { reason: 'crashed' })
  await Promise.resolve()
  expect(guest.reload).not.toHaveBeenCalled()
  expect(page.hung).toBe(false)
})

test('the stuck-page notice says when other browser nodes share the process', () => {
  expect(hungPageNotice(0)).toMatch(/Only this browser node is affected/)
  expect(hungPageNotice(1)).toMatch(/shares a process with 1 other browser node, which is stuck with it/)
  expect(hungPageNotice(3)).toMatch(/3 other browser nodes/)
})
