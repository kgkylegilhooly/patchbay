import { expect, test } from 'vitest'
import { createRunSeries, seriesText, type SeriesState } from '../../src/main/runSeries'
import type { RunResult } from '../../src/shared/contract'

// F64: a flaky test needs runs by hand, counting failures. Run N times runs it again after each end and counts.
const started = { running: true, exitCode: null, stoppedByYou: false, at: 0 } satisfies RunResult
const ended = (exitCode: number | null, stoppedByYou = false): RunResult => ({ running: false, exitCode, stoppedByYou, at: 0 })

function setup(refuse: string | null = null) {
  const restarts: string[] = []
  const later: Array<() => void> = []
  const changes: Array<SeriesState | null> = []
  const done: Array<{ id: string; text: string }> = []
  let running = false
  const series = createRunSeries({
    restart: async (id) => {
      restarts.push(id)
      return refuse ? { ok: false as const, reason: refuse } : undefined
    },
    running: () => running,
    changed: (_id, s) => void changes.push(s),
    finished: (id, text) => void done.push({ id, text }),
    schedule: (fn) => void later.push(fn)
  })
  const tick = async () => {
    for (const fn of later.splice(0)) fn()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { series, restarts, later, changes, done, tick, setRunning: (v: boolean) => (running = v) }
}

test('it runs N times, counting the failures, then says how many of how many failed', async () => {
  const s = setup()
  expect(await s.series.start('r', 3)).toEqual({ ok: true })
  expect(s.restarts).toEqual(['r'])
  const exits = [0, 1, 0]
  for (const [i, code] of exits.entries()) {
    expect(s.series.onRun('r', started)).toBe(true)
    expect(s.series.onRun('r', ended(code))).toBe(true)
    await s.tick()
    expect(s.restarts).toHaveLength(Math.min(i + 2, 3))
  }
  // The window is handed the final count; the series itself is over.
  expect(s.changes.at(-1)).toEqual({ total: 3, done: 3, failed: 1, running: false })
  expect(s.series.state('r')).toBeNull()
  expect(s.done).toEqual([{ id: 'r', text: '1 of 3 runs failed.' }])
  // Over: the run's ends are its own again.
  expect(s.series.onRun('r', started)).toBe(false)
})

test('Stop ends it, saying how far it got; a run not in a series is left alone', async () => {
  const s = setup()
  await s.series.start('r', 5)
  s.series.onRun('r', started)
  s.series.onRun('r', ended(1))
  await s.tick()
  s.series.onRun('r', started)
  s.series.onRun('r', ended(null, true))
  await s.tick()
  expect(s.restarts).toHaveLength(2)
  expect(s.done).toEqual([{ id: 'r', text: 'Stopped after 1 of 5 runs: 1 failed.' }])
  expect(s.series.onRun('other', ended(1))).toBe(false)
})

test("it won't start on a run already running or with a count that isn't 2 to 50, and a refused start ends it", async () => {
  const s = setup()
  expect(await s.series.start('r', 1)).toMatchObject({ ok: false })
  expect(await s.series.start('r', 51)).toMatchObject({ ok: false })
  s.setRunning(true)
  expect(await s.series.start('r', 5)).toEqual({ ok: false, reason: "It's running. Stop it first, or wait for it to end." })
  const refused = setup("launch.json changed what this runs. Run it by hand to see and agree to it first.")
  expect(await refused.series.start('r', 5)).toEqual({ ok: false, reason: "launch.json changed what this runs. Run it by hand to see and agree to it first." })
  expect(refused.series.state('r')).toBeNull()
})

test('forgetting a closed window ends its series without a word', async () => {
  const s = setup()
  await s.series.start('r', 5)
  s.series.forget('r')
  expect(s.series.state('r')).toBeNull()
  expect(s.series.onRun('r', ended(1))).toBe(false)
  expect(s.done).toEqual([])
})

test('the chip reads as progress while it runs, and as the count after', () => {
  expect(seriesText({ total: 5, done: 2, failed: 1, running: true })).toBe('Run 3 of 5 · 1 failed')
  expect(seriesText({ total: 5, done: 0, failed: 0, running: true })).toBe('Run 1 of 5')
  expect(seriesText({ total: 5, done: 5, failed: 0, running: false })).toBe('5 of 5 passed')
  expect(seriesText({ total: 5, done: 5, failed: 2, running: false })).toBe('2 of 5 failed')
  expect(seriesText({ total: 5, done: 3, failed: 1, running: false })).toBe('Stopped at 3 of 5 · 1 failed')
})

test("a run window's menu offers Run 5 times and Run 20 times; an agent's doesn't", async () => {
  const { nodeMenu } = await import('../../src/renderer/menus')
  const asked: Array<[string, number]> = []
  const c = new Proxy({} as import('../../src/renderer/menus').Commands, { get: (_t, key) => (key === 'runSeries' ? (id: string, n: number) => asked.push([id, n]) : () => {}) })
  const box = { x: 0, y: 0, width: 1, height: 1, parentId: null }
  const items = (node: object) => nodeMenu(c, node as never, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }).filter((e): e is import('../../src/renderer/menus').MenuItem => e !== 'separator')
  const run = items({ ...box, id: 'r', kind: 'run', title: 'npm test', cwd: 'C:\w', command: 'npm test' })
  run.find((i) => i.id === 'run-5-times')!.run()
  run.find((i) => i.id === 'run-20-times')!.run()
  expect(asked).toEqual([['r', 5], ['r', 20]])
  expect(items({ ...box, id: 'a', kind: 'claude', title: 'A', cwd: 'C:\w', sessionId: null, transcriptPath: null, after: [] }).find((i) => i.id === 'run-5-times')).toBeUndefined()
})
