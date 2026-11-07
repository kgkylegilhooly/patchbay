import type { Settings } from '../../shared/settings'
import type { BudgetState } from '../../shared/usage'

const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_REFRESH_MINUTES = 5
/** How often to look again while no source is set, in case one has been chosen. */
const IDLE_CHECK_MS = 60_000
/** A setting left blank isn't saved, so "none" is how the owner asks for no unit or label. */
const NONE = 'none'
/** A page can hang forever, and one stuck read would stop every later one. */
const READ_LIMIT_MS = 60_000
/** Longer than a day isn't a meter, and a timer past about 24 days fires at once. */
const MAX_REFRESH_MINUTES = 1440

export interface SourceConfig {
  source: 'endpoint' | 'page'
  url: string
  usedPath?: string
  limitPath?: string
  usedPattern?: string
  limitPattern?: string
  fixedLimit?: number
  unit: string
  period: string
  refreshMinutes: number
}

export type ReadResult = { ok: true; used: number; limit: number } | { ok: false; problem: string }

export function sourceConfig(s: Settings): SourceConfig | null {
  if (s.usageSource !== 'endpoint' && s.usageSource !== 'page') return null
  const fixedLimit = s.usageLimit === undefined ? null : toAmount(s.usageLimit)
  const minutes = Number(s.usageRefreshMinutes)
  const text = (value: string | undefined, fallback: string): string => (value === NONE ? '' : (value ?? fallback))
  return {
    source: s.usageSource,
    url: s.usageUrl ?? '',
    ...(s.usageUsedPath ? { usedPath: s.usageUsedPath } : {}),
    ...(s.usageLimitPath ? { limitPath: s.usageLimitPath } : {}),
    ...(s.usageUsedPattern ? { usedPattern: s.usageUsedPattern } : {}),
    ...(s.usageLimitPattern ? { limitPattern: s.usageLimitPattern } : {}),
    ...(fixedLimit === null ? {} : { fixedLimit }),
    unit: text(s.usageUnit, '$'),
    period: text(s.usagePeriod, 'today'),
    refreshMinutes: s.usageRefreshMinutes === undefined || !Number.isFinite(minutes) ? DEFAULT_REFRESH_MINUTES : Math.min(MAX_REFRESH_MINUTES, Math.max(1, minutes))
  }
}

/** Follows `data.spend[0].usd`. Only a value's own fields count, so a path can't wander into built-ins. */
export function readPath(json: unknown, path: string): unknown {
  const steps = path.match(/[^.[\]]+/g)
  if (!steps) return undefined
  let at = json
  for (const step of steps) {
    if (at === null || typeof at !== 'object' || step === '__proto__' || !Object.hasOwn(at, step)) return undefined
    at = (at as Record<string, unknown>)[step]
  }
  return at
}

/** A number, or money written as text like `$1,087.50`. Null for anything else, including negatives. */
export function toAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v !== 'string') return null
  const m = /^\s*[^\d\s.-]{0,3}\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*[A-Za-z]{0,3}\s*$/.exec(v)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

/** Why this address may not be used, or null if it may. Plain http would expose a sign-in header on the way. */
export function checkUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Enter a full address, starting with https://.'
  }
  if (parsed.protocol === 'https:') return null
  if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return null
  return 'The address has to start with https://, or be on this PC.'
}

async function readLimited(res: Response): Promise<string | null> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function readAmounts(json: unknown, cfg: SourceConfig): ReadResult {
  const used = toAmount(readPath(json, cfg.usedPath ?? ''))
  if (used === null) return { ok: false, problem: `No amount found at ${cfg.usedPath} in the reply.` }
  if (cfg.fixedLimit !== undefined) return { ok: true, used, limit: cfg.fixedLimit }
  const limit = toAmount(readPath(json, cfg.limitPath ?? ''))
  if (limit === null) return { ok: false, problem: `No limit found at ${cfg.limitPath} in the reply.` }
  return { ok: true, used, limit }
}

/** Reads the source once. No reply text or header value ever goes into a problem, so a token can't appear there. */
export async function fetchEndpoint(cfg: SourceConfig, secret: string | null, fetchFn: typeof fetch = fetch): Promise<ReadResult> {
  const bad = checkUrl(cfg.url)
  if (bad) return { ok: false, problem: bad }
  if (!cfg.usedPath) return { ok: false, problem: 'Set where to find the amount used.' }
  if (cfg.fixedLimit === undefined && !cfg.limitPath) return { ok: false, problem: 'Set a limit, or where to find it.' }

  const headers: Record<string, string> = { accept: 'application/json' }
  if (secret !== null) {
    const colon = secret.indexOf(':')
    if (colon < 1) return { ok: false, problem: 'The sign-in header has to be written as Name: value.' }
    headers[secret.slice(0, colon).trim()] = secret.slice(colon + 1).trim()
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchFn(cfg.url, {
      headers,
      signal: controller.signal,
      // A redirect could carry the sign-in header to another host.
      redirect: secret === null ? 'follow' : 'error'
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, problem: `The server refused access (${res.status}). Check the sign-in header.` }
    }
    if (!res.ok) return { ok: false, problem: `The server answered ${res.status}.` }
    const text = await readLimited(res)
    if (text === null) return { ok: false, problem: 'The reply was too large.' }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, problem: "The reply wasn't JSON. If this is a web page, choose the Page source." }
    }
    return readAmounts(json, cfg)
  } catch {
    if (controller.signal.aborted) return { ok: false, problem: 'The server took longer than 10 seconds to answer.' }
    return { ok: false, problem: secret === null ? "Couldn't reach the server." : "Couldn't reach the server, or it redirected, which isn't followed while a sign-in header is set." }
  } finally {
    clearTimeout(timer)
  }
}

export interface UsagePoller {
  start(): void
  /** Null when no source is set. */
  refreshNow(): Promise<ReadResult | null>
  stop(): void
}

export function createUsagePoller({
  settings,
  read,
  budget,
  setBudget,
  now = Date.now
}: {
  settings: () => SourceConfig | null
  read: (cfg: SourceConfig) => Promise<ReadResult>
  budget: () => BudgetState | null
  setBudget: (b: BudgetState | null) => void
  now?: () => number
}): UsagePoller {
  let inFlight: Promise<ReadResult | null> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  /** Amounts read from one address mean nothing once another is set. */
  let readFrom: string | null = null

  const once = async (): Promise<ReadResult | null> => {
    const cfg = settings()
    if (!cfg) {
      readFrom = null
      setBudget(null)
      return null
    }
    let limit: ReturnType<typeof setTimeout> | undefined
    const gaveUp = new Promise<ReadResult>((resolve) => {
      limit = setTimeout(() => resolve({ ok: false, problem: 'Reading the usage source took too long.' }), READ_LIMIT_MS)
    })
    const result = await Promise.race([read(cfg).catch((): ReadResult => ({ ok: false, problem: "The usage source couldn't be read." })), gaveUp])
    clearTimeout(limit)
    const shared = { unit: cfg.unit, period: cfg.period }
    if (result.ok) {
      setBudget({ used: result.used, limit: result.limit, ...shared, at: now(), problem: null })
    } else {
      const last = readFrom === null || readFrom === cfg.url ? budget() : null
      setBudget({ used: last?.used ?? -1, limit: last?.limit ?? -1, ...shared, at: last?.at ?? now(), problem: result.problem })
    }
    readFrom = cfg.url
    return result
  }

  const refreshNow = (): Promise<ReadResult | null> => {
    inFlight ??= once().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const schedule = (): void => {
    if (!running) return
    const cfg = settings()
    timer = setTimeout(() => void refreshNow().finally(schedule), cfg ? cfg.refreshMinutes * 60_000 : IDLE_CHECK_MS)
    timer.unref?.()
  }

  return {
    start() {
      running = true
      void refreshNow().finally(schedule)
    },
    refreshNow,
    stop() {
      running = false
      if (timer) clearTimeout(timer)
    }
  }
}
