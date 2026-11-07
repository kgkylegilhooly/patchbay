import { afterEach, expect, test, vi } from 'vitest'
import { mergeSettings, parseSettings } from '../../src/main/lifecycle'
import { checkUrl, createUsagePoller, fetchEndpoint, readPath, sourceConfig, toAmount, type SourceConfig } from '../../src/main/usage/usageSource'
import type { BudgetState } from '../../src/shared/usage'

const cfg = (over: Partial<SourceConfig> = {}): SourceConfig => ({
  source: 'endpoint',
  url: 'https://org.example/usage',
  usedPath: 'spend.used',
  fixedLimit: 150,
  unit: '$',
  period: 'today',
  refreshMinutes: 5,
  ...over
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const SECRET = 'Authorization: Bearer top-secret-value'

afterEach(() => {
  vi.useRealTimers()
})

test('readPath follows dots and indexes', () => {
  expect(readPath({ data: { spend: [{ usd: 87 }] } }, 'data.spend[0].usd')).toBe(87)
  expect(readPath([1, 2], '[1]')).toBe(2)
})

test('readPath is undefined for anything missing', () => {
  expect(readPath({ data: {} }, 'data.spend[0].usd')).toBeUndefined()
  expect(readPath(null, 'a')).toBeUndefined()
  expect(readPath({ a: 1 }, 'a.b')).toBeUndefined()
  expect(readPath({ a: 1 }, '')).toBeUndefined()
})

test('readPath does not reach __proto__ or constructor', () => {
  expect(readPath({}, '__proto__')).toBeUndefined()
  expect(readPath({}, 'constructor')).toBeUndefined()
  expect(readPath({}, 'toString')).toBeUndefined()
})

test('toAmount accepts numbers and money text', () => {
  expect(toAmount(87.5)).toBe(87.5)
  expect(toAmount('87.50')).toBe(87.5)
  expect(toAmount('$1,087.50')).toBe(1087.5)
  expect(toAmount(0)).toBe(0)
})

test.each([[''], [null], [undefined], [-3], ['-3'], [NaN], ['abc'], [{}], ['1.2.3']])('toAmount refuses %s', (v) => {
  expect(toAmount(v)).toBeNull()
})

test('checkUrl allows https and local http', () => {
  expect(checkUrl('https://org.example/usage')).toBeNull()
  expect(checkUrl('http://localhost:3000/x')).toBeNull()
  expect(checkUrl('http://127.0.0.1:3000/x')).toBeNull()
})

test.each(['http://org.example/x', 'file:///C:/x', 'javascript:alert(1)', 'not a url', '', 'http://localhost.evil.example/'])('checkUrl refuses %s', (url) => {
  expect(checkUrl(url)).toBeTruthy()
})

test('a fixed limit is used', async () => {
  const fetchFn = vi.fn(async () => json({ spend: { used: 87 } }))
  expect(await fetchEndpoint(cfg(), null, fetchFn)).toEqual({ ok: true, used: 87, limit: 150 })
})

test('a limit path reads the limit from the same reply', async () => {
  const fetchFn = async () => json({ spend: { used: '$87.50', cap: '$150' } })
  expect(await fetchEndpoint(cfg({ fixedLimit: undefined, limitPath: 'spend.cap' }), null, fetchFn)).toEqual({ ok: true, used: 87.5, limit: 150 })
})

test('no limit configured says so without asking the server', async () => {
  const fetchFn = vi.fn(async () => json({}))
  const r = await fetchEndpoint(cfg({ fixedLimit: undefined }), null, fetchFn)
  expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/limit/i) })
  expect(fetchFn).not.toHaveBeenCalled()
})

test('a bad URL is refused without asking the server', async () => {
  const fetchFn = vi.fn(async () => json({}))
  expect((await fetchEndpoint(cfg({ url: 'http://org.example/' }), null, fetchFn)).ok).toBe(false)
  expect(fetchFn).not.toHaveBeenCalled()
})

test.each([
  [401, /sign-in header/],
  [403, /sign-in header/],
  [404, /404/],
  [500, /500/]
])('status %i names the problem', async (status, pattern) => {
  const r = await fetchEndpoint(cfg(), null, async () => json({}, status))
  expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(pattern) })
})

test('HTML where JSON was expected says so', async () => {
  const r = await fetchEndpoint(cfg(), null, async () => new Response('<html>Sign in</html>'))
  expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/JSON/) })
})

test('a missing field names the path that was tried', async () => {
  const r = await fetchEndpoint(cfg(), null, async () => json({ spend: {} }))
  expect(r).toMatchObject({ ok: false, problem: expect.stringContaining('spend.used') })
})

test('a value that is not an amount says what it found', async () => {
  const r = await fetchEndpoint(cfg(), null, async () => json({ spend: { used: 'lots' } }))
  expect(r).toMatchObject({ ok: false, problem: expect.stringContaining('spend.used') })
})

test('a slow server gives up at 10 s', async () => {
  vi.useFakeTimers()
  const hang = (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  const read = fetchEndpoint(cfg(), null, hang as typeof fetch)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await read).toMatchObject({ ok: false, problem: expect.stringMatching(/10 seconds/) })
})

test('a body over 1 MB is refused', async () => {
  const r = await fetchEndpoint(cfg(), null, async () => new Response('x'.repeat(1024 * 1024 + 1)))
  expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/too large/) })
})

test('a network failure says the server could not be reached', async () => {
  const r = await fetchEndpoint(cfg(), null, async () => {
    throw new TypeError('fetch failed')
  })
  expect(r).toMatchObject({ ok: false, problem: expect.stringMatching(/reach/) })
})

test('the secret goes out as the named header', async () => {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => json({ spend: { used: 1 } }))
  await fetchEndpoint(cfg(), SECRET, fetchFn as typeof fetch)
  expect(new Headers(fetchFn.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer top-secret-value')
})

test('with a secret set, redirects are refused, so it cannot be carried to another host', async () => {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => json({ spend: { used: 1 } }))
  await fetchEndpoint(cfg(), SECRET, fetchFn as typeof fetch)
  expect(fetchFn.mock.calls[0][1]?.redirect).toBe('error')
})

test('with no secret, redirects are followed and no header is added', async () => {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => json({ spend: { used: 1 } }))
  await fetchEndpoint(cfg(), null, fetchFn as typeof fetch)
  expect(fetchFn.mock.calls[0][1]?.redirect).toBe('follow')
  expect(new Headers(fetchFn.mock.calls[0][1]?.headers).get('authorization')).toBeNull()
})

test('no problem text ever contains the secret, even when the server or network echoes it', async () => {
  const echoes = [
    async () => json({ spend: { used: 'Bearer top-secret-value' } }),
    async () => new Response('Bearer top-secret-value'),
    async () => {
      throw new Error('failed with Bearer top-secret-value')
    }
  ]
  for (const fetchFn of echoes) {
    const r = await fetchEndpoint(cfg({ usedPath: 'spend.used' }), SECRET, fetchFn)
    expect(JSON.stringify(r)).not.toContain('top-secret-value')
  }
})

test('a header with no colon says how to write it, without repeating it', async () => {
  const r = await fetchEndpoint(cfg(), 'top-secret-value', async () => json({}))
  expect(r.ok).toBe(false)
  expect(JSON.stringify(r)).not.toContain('top-secret-value')
})

function pollerWith(read: (c: SourceConfig) => Promise<{ ok: true; used: number; limit: number } | { ok: false; problem: string }>, settings: () => SourceConfig | null = () => cfg()) {
  const budgets: Array<BudgetState | null> = []
  let current: BudgetState | null = null
  const poller = createUsagePoller({
    settings,
    read,
    budget: () => current,
    setBudget: (b) => {
      current = b
      budgets.push(b)
    },
    now: () => 1000
  })
  return { poller, budgets, last: () => budgets.at(-1) }
}

test('a good read sets the budget', async () => {
  const { poller, last } = pollerWith(async () => ({ ok: true, used: 87, limit: 150 }))
  await poller.refreshNow()
  expect(last()).toEqual({ used: 87, limit: 150, unit: '$', period: 'today', at: 1000, problem: null })
})

test('a failed read keeps the last amounts and sets the problem, and the next success clears it', async () => {
  let ok = true
  const { poller, last } = pollerWith(async () => (ok ? { ok: true, used: 87, limit: 150 } : { ok: false, problem: 'The server said 500.' }))
  await poller.refreshNow()
  ok = false
  await poller.refreshNow()
  expect(last()).toMatchObject({ used: 87, limit: 150, problem: 'The server said 500.' })
  ok = true
  await poller.refreshNow()
  expect(last()?.problem).toBeNull()
})

test('a first read that fails has no amounts to keep', async () => {
  const { poller, last } = pollerWith(async () => ({ ok: false, problem: 'Nope.' }))
  await poller.refreshNow()
  expect(last()).toMatchObject({ used: -1, limit: -1, problem: 'Nope.' })
})

test('never two reads at once', async () => {
  let release = (): void => {}
  const read = vi.fn(() => new Promise<{ ok: true; used: number; limit: number }>((r) => (release = () => r({ ok: true, used: 1, limit: 2 }))))
  const { poller } = pollerWith(read)
  const first = poller.refreshNow()
  const second = poller.refreshNow()
  release()
  await Promise.all([first, second])
  expect(read).toHaveBeenCalledTimes(1)
})

test('a settings change applies at the next read', async () => {
  let current = cfg({ period: 'today' })
  const { poller, last } = pollerWith(async () => ({ ok: true, used: 1, limit: 2 }), () => current)
  await poller.refreshNow()
  current = cfg({ period: 'this week' })
  await poller.refreshNow()
  expect(last()?.period).toBe('this week')
})

test('with no configured source nothing is read, and the budget is cleared', async () => {
  const read = vi.fn(async () => ({ ok: true as const, used: 1, limit: 2 }))
  const { poller, last } = pollerWith(read, () => null)
  await poller.refreshNow()
  expect(read).not.toHaveBeenCalled()
  expect(last()).toBeNull()
})

test('it reads on a timer at the configured interval, and stop ends that', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => ({ ok: true as const, used: 1, limit: 2 }))
  const { poller } = pollerWith(read, () => cfg({ refreshMinutes: 2 }))
  poller.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  expect(read).toHaveBeenCalledTimes(2)
  poller.stop()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(read).toHaveBeenCalledTimes(2)
})

test('sourceConfig is null for claude and off, and for nothing set', () => {
  expect(sourceConfig({})).toBeNull()
  expect(sourceConfig({ usageSource: 'claude', usageUrl: 'https://x.example' })).toBeNull()
  expect(sourceConfig({ usageSource: 'off' })).toBeNull()
})

test('sourceConfig fills defaults and enforces the minimum refresh', () => {
  expect(sourceConfig({ usageSource: 'endpoint', usageUrl: 'https://x.example', usageUsedPath: 'a', usageLimit: '150', usageRefreshMinutes: '0' })).toEqual({
    source: 'endpoint',
    url: 'https://x.example',
    usedPath: 'a',
    fixedLimit: 150,
    unit: '$',
    period: 'today',
    refreshMinutes: 1
  })
})

test('sourceConfig keeps an empty unit or period the owner chose', () => {
  const c = sourceConfig({ usageSource: 'endpoint', usageUnit: 'none', usagePeriod: 'none' })
  expect(c).toMatchObject({ unit: '', period: '' })
})

test('custom usage sources are switched off, so nothing is ever fetched, whatever settings.json holds', () => {
  const settings = parseSettings(JSON.stringify({ usageSource: 'endpoint', usageUrl: 'https://x.example', usageUsedPath: 'a', usageLimit: '150' }))
  expect(sourceConfig(settings)).toBeNull()
})

test('saving settings keeps those fields in the file, in case the feature comes back', () => {
  const text = mergeSettings(JSON.stringify({ usageUrl: 'https://x.example' }), { shell: 'a.exe' })
  expect(JSON.parse(text!)).toEqual({ usageUrl: 'https://x.example', shell: 'a.exe' })
})

test('a read that never answers gives up, and the next read still runs', async () => {
  vi.useFakeTimers()
  const read = vi.fn((): Promise<{ ok: false; problem: string }> => new Promise(() => {}))
  const { poller, last } = pollerWith(read)
  const first = poller.refreshNow()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await first).toMatchObject({ ok: false, problem: expect.stringMatching(/too long/) })
  expect(last()?.problem).toMatch(/too long/)
  const second = poller.refreshNow()
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(60_000)
  await second
})

test('a very long refresh is capped, because a timer that long fires at once', () => {
  expect(sourceConfig({ usageSource: 'endpoint', usageRefreshMinutes: '99999' })?.refreshMinutes).toBe(1440)
})
