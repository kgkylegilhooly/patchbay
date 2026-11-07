import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createUsageService } from '../../src/main/usage/usageService'

let dir: string
let time: number
const now = (): number => time
const service = () => createUsageService({ dataDir: dir, now })
const window = (percent: number, resetsAt = 2000) => ({ percent, resetsAt })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay usage '))
  time = 1000 * 1000
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('the newest report wins, from any session, because limits belong to the account', () => {
  const s = service()
  s.report('a', { fiveHour: window(10) })
  s.report('b', { fiveHour: window(20) })
  expect(s.state().plan?.fiveHour?.percent).toBe(20)
})

test('a report with no limits keeps the known ones', () => {
  const s = service()
  s.report('a', { fiveHour: window(10), sevenDay: window(5) })
  s.report('b', { contextPercent: 3 })
  s.report('a', { sevenDay: window(6) })
  expect(s.state().plan).toMatchObject({ fiveHour: { percent: 10 }, sevenDay: { percent: 6 } })
})

test('each window keeps its own numbers per node, and a later report only replaces what it holds', () => {
  const s = service()
  s.report('a', { contextPercent: 34, tokens: 100, costUsd: 0.5 })
  s.report('a', { contextPercent: 40 })
  s.report('b', { contextPercent: 1 })
  expect(s.state().nodes).toEqual({ a: { contextPercent: 40, tokens: 100, costUsd: 0.5 }, b: { contextPercent: 1 } })
})

test('a window past its reset time is dropped from state()', () => {
  const s = service()
  s.report('a', { fiveHour: window(90, 1500), sevenDay: window(5, 9000) })
  time = 1500 * 1000
  expect(s.state().plan?.fiveHour).toBeUndefined()
  expect(s.state().plan?.sevenDay?.percent).toBe(5)
})

test('with every window past its reset there is no plan', () => {
  const s = service()
  s.report('a', { fiveHour: window(90, 1500) })
  time = 1600 * 1000
  expect(s.state().plan).toBeNull()
})

test('plan numbers and the budget survive a restart, with their age', async () => {
  const s = service()
  s.report('a', { fiveHour: window(48), contextPercent: 3 })
  s.setBudget({ used: 87, limit: 150, unit: '$', period: 'today', at: 5, problem: null })
  await s.flush()
  time += 60_000
  const again = service().state()
  expect(again.plan).toMatchObject({ fiveHour: { percent: 48 }, at: 1000 * 1000 })
  expect(again.budget?.used).toBe(87)
  expect(again.nodes).toEqual({})
})

test('a corrupt usage.json means no numbers, not a failure', () => {
  writeFileSync(join(dir, 'usage.json'), '{ oops')
  expect(service().state()).toEqual({ plan: null, nodes: {}, budget: null })
})

test('a usage.json of the wrong shape means no numbers', () => {
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ plan: { fiveHour: 'x' }, budget: 7 }))
  expect(service().state()).toEqual({ plan: null, nodes: {}, budget: null })
})

test('forget removes a closed node', () => {
  const s = service()
  s.report('a', { contextPercent: 3 })
  s.forget('a')
  expect(s.state().nodes).toEqual({})
})

test('listeners hear a change, and not a report that changed nothing', () => {
  const s = service()
  const changed = vi.fn()
  s.onChange(changed)
  s.report('a', { contextPercent: 3 })
  s.report('a', { contextPercent: 3 })
  s.forget('nobody')
  expect(changed).toHaveBeenCalledTimes(1)
})

test('a limit report with the same numbers refreshes their age', () => {
  const s = service()
  s.report('a', { fiveHour: window(10) })
  time += 5000
  s.report('a', { fiveHour: window(10) })
  expect(s.state().plan?.at).toBe(time)
})

test('saving writes the file', async () => {
  const s = service()
  s.report('a', { fiveHour: window(48) })
  await s.flush()
  expect(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).plan.fiveHour.percent).toBe(48)
})

test('turning the pill off shows in the state and tells listeners, once', () => {
  const s = service()
  const changed = vi.fn()
  s.onChange(changed)
  s.setOff(true)
  s.setOff(true)
  expect(s.state().off).toBe(true)
  expect(changed).toHaveBeenCalledTimes(1)
  s.setOff(false)
  expect(s.state().off).toBeUndefined()
})

test('a failed Codex read keeps the last good windows and says why, and a reset window drops out', () => {
  let t = 1_000_000
  const usage = createUsageService({ dataDir: dir, now: () => t })
  usage.setCodex({ windows: [{ percent: 13, minutes: 43200, resetsAt: 2000 }], account: { email: 'me@example.com' }, at: t, problem: null })
  usage.setCodex({ problem: 'Codex took too long to answer', at: t + 1 })
  expect(usage.state().codex).toEqual({ windows: [{ percent: 13, minutes: 43200, resetsAt: 2000 }], account: { email: 'me@example.com' }, at: t, problem: 'Codex took too long to answer' })
  t = 3_000_000
  expect(usage.state().codex?.windows).toEqual([])
})
