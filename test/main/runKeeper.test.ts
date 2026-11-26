import { expect, test } from 'vitest'
import { createRunKeeper } from '../../src/main/runKeeper'
import type { RunResult } from '../../src/shared/contract'

// F50: a dev server that crashes is started again, a little later each time, and given up on if it keeps crashing.
function harness(keep = true) {
  let now = 0
  const timers: Array<{ at: number; fn: () => void }> = []
  const restarted: string[] = []
  const gaveUp: string[] = []
  const running = new Set<string>()
  const k = createRunKeeper({
    keep: () => keep,
    running: (id) => running.has(id),
    restart: async (id) => void restarted.push(`${id}@${now}`),
    gaveUp: (id) => gaveUp.push(id),
    now: () => now,
    schedule: (fn, ms) => void timers.push({ at: now + ms, fn })
  })
  const run = (over: Partial<RunResult>): RunResult => ({ running: false, exitCode: 1, stoppedByYou: false, at: now, ...over })
  const tick = (to: number): void => {
    now = to
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) if (t.at <= now) t.fn()
      else timers.push(t)
  }
  return { k, run, tick, restarted, gaveUp, running, at: (t: number) => (now = t) }
}

test('a crash restarts it after 2 s, then 5 s, then 15 s; a fourth crash within a minute gives up', () => {
  const h = harness()
  const crash = (): string => (h.k.onRun('r', h.run({ running: true })), h.k.onRun('r', h.run({})))
  expect(crash()).toBe('restarting')
  h.tick(2000)
  expect(h.restarted).toEqual(['r@2000'])
  expect(crash()).toBe('restarting')
  h.tick(7000)
  expect(crash()).toBe('restarting')
  h.tick(22000)
  expect(h.restarted).toEqual(['r@2000', 'r@7000', 'r@22000'])
  expect(crash()).toBe('gave-up')
  expect(h.gaveUp).toEqual(['r'])
})

test('a clean exit, a Stop, an end seen only at start-up, or the option off restarts nothing', () => {
  const h = harness()
  h.k.onRun('r', h.run({ running: true }))
  expect(h.k.onRun('r', h.run({ exitCode: 0 }))).toBe('none')
  h.k.onRun('r', h.run({ running: true }))
  expect(h.k.onRun('r', h.run({ stoppedByYou: true }))).toBe('none')
  // Ended while Patchbay was closed: never seen running.
  expect(h.k.onRun('s', h.run({}))).toBe('none')
  const off = harness(false)
  off.k.onRun('r', off.run({ running: true }))
  expect(off.k.onRun('r', off.run({}))).toBe('none')
  h.tick(60_000)
  expect(h.restarted).toEqual([])
})

test('a restart that is no longer needed, because it was started by hand or switched off, does nothing', () => {
  const h = harness()
  h.k.onRun('r', h.run({ running: true }))
  h.k.onRun('r', h.run({}))
  h.running.add('r')
  h.tick(2000)
  expect(h.restarted).toEqual([])
})
