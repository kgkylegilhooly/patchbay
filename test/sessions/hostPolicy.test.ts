import { describe, expect, test } from 'vitest'
import { DEFAULT_HOST_LIMITS, HOST_EMPTY_MS, HOST_ORPHAN_MS, HOST_TICK_MS, limitsFrom, startPolicy, stepPolicy, type HostExitReason } from '../../src/main/sessions/hostPolicy'

/** Runs the policy for `ms` of awake time, a tick at a time. */
function run(ms: number, seen: { connected?: boolean; running?: number; dataPresent?: boolean }): { exit: HostExitReason | null; at: number } {
  let state = startPolicy(0)
  let now = 0
  while (now < ms) {
    now += HOST_TICK_MS
    const step = stepPolicy(state, { now, connected: seen.connected ?? false, running: seen.running ?? 0, dataPresent: seen.dataPresent ?? true })
    state = step.state
    if (step.exit) return { exit: step.exit, at: now }
  }
  return { exit: null, at: now }
}

describe('the host never ends during ordinary use', () => {
  test('a connected app holds off everything, whatever else is true', () => {
    expect(run(HOST_ORPHAN_MS * 3, { connected: true, running: 3 }).exit).toBeNull()
    expect(run(HOST_ORPHAN_MS, { connected: true, running: 0 }).exit).toBeNull()
    expect(run(HOST_ORPHAN_MS, { connected: true, running: 1, dataPresent: false }).exit).toBeNull()
  })

  test('sessions keep running for just under the limit with the app closed', () => {
    expect(run(HOST_ORPHAN_MS - HOST_TICK_MS, { running: 2 }).exit).toBeNull()
  })

  test('the limit is long enough to cover a long weekend', () => {
    expect(HOST_ORPHAN_MS).toBeGreaterThanOrEqual(5 * 24 * 60 * 60 * 1000)
  })

  test('connecting starts every clock again', () => {
    let state = startPolicy(0)
    state = stepPolicy(state, { now: HOST_TICK_MS, connected: false, running: 1, dataPresent: true }).state
    const back = stepPolicy(state, { now: HOST_TICK_MS * 2, connected: true, running: 1, dataPresent: true })
    expect(back.exit).toBeNull()
    expect(back.state).toEqual(startPolicy(HOST_TICK_MS * 2))
  })
})

describe('sleeping does not count', () => {
  test('a long sleep past the limit ends nothing on waking', () => {
    const step = stepPolicy(startPolicy(0), { now: HOST_ORPHAN_MS * 4, connected: false, running: 2, dataPresent: true })
    expect(step.exit).toBeNull()
    expect(step.state.away).toBe(HOST_TICK_MS * 2)
  })

  test('a clock moved backward counts as nothing', () => {
    const step = stepPolicy(startPolicy(1000), { now: 0, connected: false, running: 1, dataPresent: true })
    expect(step.state.away).toBe(0)
  })
})

describe('a host with no reason to stay does end', () => {
  test('running sessions with nobody connected, after the orphan limit', () => {
    const { exit, at } = run(HOST_ORPHAN_MS * 2, { running: 1 })
    expect(exit).toBe('orphaned')
    expect(at).toBe(HOST_ORPHAN_MS)
  })

  test('nothing running, after the much shorter empty limit', () => {
    const { exit, at } = run(HOST_ORPHAN_MS, { running: 0 })
    expect(exit).toBe('empty')
    expect(at).toBe(HOST_EMPTY_MS)
  })

  test('the profile gone, even with sessions running', () => {
    expect(run(HOST_ORPHAN_MS, { running: 2, dataPresent: false }).exit).toBe('data-gone')
  })

  test('a session starting resets the empty clock', () => {
    let state = startPolicy(0)
    state = stepPolicy(state, { now: HOST_TICK_MS, connected: false, running: 0, dataPresent: true }).state
    state = stepPolicy(state, { now: HOST_TICK_MS * 2, connected: false, running: 1, dataPresent: true }).state
    expect(state.empty).toBe(0)
  })

  test('the profile coming back resets its clock', () => {
    let state = startPolicy(0)
    state = stepPolicy(state, { now: HOST_TICK_MS, connected: false, running: 1, dataPresent: false }).state
    state = stepPolicy(state, { now: HOST_TICK_MS * 2, connected: false, running: 1, dataPresent: true }).state
    expect(state.dataGone).toBe(0)
  })
})

describe('limitsFrom', () => {
  test('uses the defaults without a usable override', () => {
    expect(limitsFrom(undefined)).toEqual(DEFAULT_HOST_LIMITS)
    expect(limitsFrom('{nope')).toEqual(DEFAULT_HOST_LIMITS)
  })

  test('takes valid fields and ignores the rest', () => {
    expect(limitsFrom(JSON.stringify({ orphanMs: 5, tickMs: -1, emptyMs: 'x' }))).toEqual({ ...DEFAULT_HOST_LIMITS, orphanMs: 5 })
  })
})
