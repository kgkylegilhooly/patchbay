import { expect, test } from 'vitest'
import { contextLabel, pillText } from '../../src/renderer/usageView'
import type { BudgetState, UsageState } from '../../src/shared/usage'

const NOW = 1000 * 1000
const FUTURE = 5000
const state = (over: Partial<UsageState> = {}): UsageState => ({ plan: null, nodes: {}, budget: null, ...over })
const plan = (five?: number, week?: number, at = NOW): UsageState['plan'] => ({
  ...(five === undefined ? {} : { fiveHour: { percent: five, resetsAt: FUTURE } }),
  ...(week === undefined ? {} : { sevenDay: { percent: week, resetsAt: FUTURE } }),
  at
})
const budget = (over: Partial<BudgetState> = {}): BudgetState => ({ used: 87, limit: 150, unit: '$', period: 'today', at: NOW, problem: null, ...over })

test('nothing known is no pill', () => {
  expect(pillText(state(), NOW)).toBeNull()
})

test('plan limits read as written, and are ok below 70', () => {
  const p = pillText(state({ plan: plan(48, 20) }), NOW)
  expect(p?.text).toBe('48% 5h · 20% wk')
  expect(p?.level).toBe('ok')
  expect(p?.stale).toBe(false)
})

test.each([
  [60, 'ok'],
  [61, 'warn'],
  [80, 'warn'],
  [81, 'high']
])('the highest number sets the level: %i is %s', (percent, level) => {
  expect(pillText(state({ plan: plan(1, percent) }), NOW)?.level).toBe(level)
})

test('only one window present shows only that one', () => {
  expect(pillText(state({ plan: plan(undefined, 20) }), NOW)?.text).toBe('20% wk')
})

test('a window past its reset is not shown, even before main next says so', () => {
  const s = state({ plan: { fiveHour: { percent: 95, resetsAt: 500 }, sevenDay: { percent: 20, resetsAt: FUTURE }, at: NOW } })
  expect(pillText(s, NOW)?.text).toBe('20% wk')
  expect(pillText(s, NOW)?.level).toBe('ok')
})

test('old plan numbers are dimmed and say how old they are', () => {
  const p = pillText(state({ plan: plan(48, 20, NOW - 40 * 60_000) }), NOW)
  expect(p?.stale).toBe(true)
  expect(p?.detail).toContain('40 minutes ago')
})

test('a budget wins, with the plan numbers in its detail', () => {
  const p = pillText(state({ budget: budget(), plan: plan(48, 20) }), NOW)
  expect(p?.text).toBe('$87 of $150 today')
  expect(p?.detail).toContain('5-hour limit: 48%')
})

test('the level comes from used over limit', () => {
  expect(pillText(state({ budget: budget() }), NOW)?.level).toBe('ok')
  expect(pillText(state({ budget: budget({ used: 105 }) }), NOW)?.level).toBe('warn')
  expect(pillText(state({ budget: budget({ used: 125 }) }), NOW)?.level).toBe('high')
})

test('amounts keep cents only below 100, and use thousands separators', () => {
  expect(pillText(state({ budget: budget({ used: 87.5, limit: 1500 }) }), NOW)?.text).toBe('$87.50 of $1,500 today')
  expect(pillText(state({ budget: budget({ used: 1087.5, limit: 2000 }) }), NOW)?.text).toBe('$1,088 of $2,000 today')
})

test('a unit can be empty, and a period too', () => {
  expect(pillText(state({ budget: budget({ unit: '', used: 50, limit: 80, period: '' }) }), NOW)?.text).toBe('50 of 80')
})

test('a problem dims the last amounts and gives the reason', () => {
  const p = pillText(state({ budget: budget({ problem: 'The server said 401.' }) }), NOW)
  expect(p?.text).toBe('$87 of $150 today')
  expect(p?.stale).toBe(true)
  expect(p?.detail).toContain('The server said 401.')
})

test('over the limit is high and shows the real amount', () => {
  const p = pillText(state({ budget: budget({ used: 180 }) }), NOW)
  expect(p?.text).toBe('$180 of $150 today')
  expect(p?.level).toBe('high')
})

test('a limit of zero does not divide by zero', () => {
  expect(pillText(state({ budget: budget({ used: 1, limit: 0 }) }), NOW)?.level).toBe('high')
  expect(pillText(state({ budget: budget({ used: 0, limit: 0 }) }), NOW)?.level).toBe('ok')
})

test('a budget with no reading yet says what is wrong rather than showing zero', () => {
  const p = pillText(state({ budget: budget({ used: -1, limit: -1, problem: 'Not found.' }) }), NOW)
  expect(p?.text).toBe('Usage unavailable')
  expect(p?.stale).toBe(true)
  expect(p?.detail).toContain('Not found.')
})

test('the context label uses the same levels, and hover says the cost is an estimate', () => {
  const label = contextLabel({ contextPercent: 72, tokens: 12345, costUsd: 0.5 })
  expect(label?.text).toBe('72% context')
  expect(label?.level).toBe('warn')
  expect(label?.detail).toContain('12,345 tokens')
  expect(label?.detail).toContain('$0.50 at API prices')
})

test('with no context number there is no label', () => {
  expect(contextLabel({ tokens: 3 })).toBeNull()
  expect(contextLabel(undefined)).toBeNull()
})

test('with the source turned off there is no pill, whatever is known', () => {
  expect(pillText(state({ plan: plan(48, 20), off: true }), NOW)).toBeNull()
})

test('in left mode the numbers and the bar show what remains, while the colour still follows real use', () => {
  const p = pillText(state({ plan: plan(85, 20) }), NOW, 'left')
  expect(p?.text).toBe('15% 5h · 80% wk')
  expect(p?.level).toBe('high')
  expect(p?.barPercent).toBe(15)
})

test('the bar follows whichever limit is closest to running out', () => {
  expect(pillText(state({ plan: plan(30, 75) }), NOW)?.barPercent).toBe(75)
})

test('each limit gets a row with its bar, percentage, colour and countdown', () => {
  const soon = (NOW + 2 * 3600_000 + 5 * 60_000) / 1000
  const far = (NOW + 3 * 86400_000 + 4 * 3600_000) / 1000
  const s = state({ plan: { fiveHour: { percent: 48, resetsAt: soon }, sevenDay: { percent: 85, resetsAt: far }, at: NOW } })
  expect(pillText(s, NOW, 'left')?.rows).toEqual([
    { label: '5-hour limit', percentText: '52% left', barPercent: 52, level: 'ok', resets: 'Resets in 2h 5m' },
    { label: 'Weekly limit', percentText: '15% left', barPercent: 15, level: 'high', resets: 'Resets in 3d 4h' }
  ])
  expect(pillText(s, NOW, 'used')?.rows?.[0].percentText).toBe('48% used')
})

test('a reset under an hour away is given in minutes', () => {
  const s = state({ plan: { fiveHour: { percent: 1, resetsAt: (NOW + 9 * 60_000) / 1000 }, at: NOW } })
  expect(pillText(s, NOW)?.rows?.[0].resets).toBe('Resets in 9m')
})

test('the panel says when the numbers were last updated', () => {
  expect(pillText(state({ plan: plan(1, 1, NOW - 5 * 60_000) }), NOW)?.updated).toBe('Updated 5m ago')
  expect(pillText(state({ plan: plan(1, 1) }), NOW)?.updated).toBe('Updated just now')
})

const codex = (percent: number, minutes = 43200, over: Partial<NonNullable<UsageState['codex']>> = {}): UsageState['codex'] => ({
  windows: [{ percent, minutes, resetsAt: FUTURE }],
  account: { email: 'me@example.com', plan: 'free' },
  at: NOW,
  problem: null,
  ...over
})

test('Codex joins the pill after Claude, and the left mode reads as the share left', () => {
  const p = pillText(state({ plan: plan(17, 72), codex: codex(13) }), NOW, 'left')
  expect(p?.text).toBe('83% 5h · 28% wk · 87% Codex')
  expect(p?.codex?.rows).toEqual([{ label: 'Monthly limit', percentText: '87% left', barPercent: 87, level: 'ok', resets: expect.any(String) }])
  expect(p?.codex?.account).toEqual({ email: 'me@example.com', detail: 'Free plan' })
})

test('Codex alone is enough for a pill, and its closest limit sets the level', () => {
  const p = pillText(state({ codex: { ...codex(30, 300)!, windows: [{ percent: 30, minutes: 300, resetsAt: FUTURE }, { percent: 85, minutes: 10080, resetsAt: FUTURE }] } }), NOW)
  expect(p?.text).toBe('85% Codex')
  expect(p?.level).toBe('high')
  expect(p?.codex?.rows.map((r) => r.label)).toEqual(['5-hour limit', 'Weekly limit'])
  expect(p?.rows).toEqual([])
})

test('a Codex read that failed says why, and the Claude account shows under Claude', () => {
  const p = pillText(state({ plan: plan(10), codex: codex(13, 43200, { problem: "Codex didn't say its limits: it took too long to answer" }), claudeAccount: { email: 'me@example.com', organization: 'Acme', plan: 'pro' } }), NOW)
  expect(p?.codex?.problem).toMatch(/took too long/)
  expect(p?.claudeAccount).toEqual({ email: 'me@example.com', detail: 'Pro plan · Organization: Acme' })
})
