import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProgram } from '../../core/git/run'

/**
 * What decides whether a session's http hooks would reach the session host directly. See docs/plans/host-hooks.md.
 *
 * Claude Code sends an http hook through HTTP(S)_PROXY unless the URL's host is listed, exactly, in NO_PROXY: loopback
 * isn't exempt by itself, and `localhost` doesn't cover `127.0.0.1` (checked with 2.1.330 and a stand-in proxy). Through
 * a proxy every hook fails, and the proxy would see each event. So a session with http hooks gets 127.0.0.1 added to
 * its NO_PROXY, and anything that could undo that, or route hooks elsewhere, keeps the command hooks instead.
 */

const LOOPBACK = '127.0.0.1'
const PROXY_NAMES = /^(https?_proxy|all_proxy|no_proxy)$/i

/** The session's environment with 127.0.0.1 added to NO_PROXY, keeping what's there. */
export function withLoopbackNoProxy(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const keys = Object.keys(env).filter((k) => /^no_proxy$/i.test(k))
  const entries = keys.flatMap((k) => env[k].split(',').map((e) => e.trim())).filter(Boolean)
  const merged = [...new Set([...entries, LOOPBACK])].join(',')
  const out = { ...env }
  for (const k of keys) delete out[k]
  // Windows reads names in any case, and two names differing only in case would both reach the program.
  return platform === 'win32' ? { ...out, NO_PROXY: merged } : { ...out, NO_PROXY: merged, no_proxy: merged }
}

export interface ClaudeSettingsPlaces {
  cwd: string
  home: string
  /** CLAUDE_CONFIG_DIR, when the session has one: Claude reads the person's settings there instead. */
  configDir?: string
  /** Machine-wide settings an administrator set. Defaults to the Windows location; its managed-settings.d beside it. */
  managedFile?: string
  /** The registry's policy. Defaults to what loadRegistryPolicy read. */
  registry?: RegistryPolicy[]
}

export const MANAGED_FILE = 'C:\\Program Files\\ClaudeCode\\managed-settings.json'

function readSettings(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Why this session must keep command hooks, read from the Claude settings it will start with, or null when http hooks
 * are safe. Only read, never changed.
 * - a proxy variable in a settings `env`: Claude applies it over the session's environment, so the NO_PROXY added here
 *   could be undone;
 * - the sandbox turned on: with network rules, Claude can route http hooks through the sandbox's own proxy, which
 *   allows only listed hosts;
 * - an allowlist of http hook URLs: it may not list the host's.
 */
export function httpHooksBlocked(places: ClaudeSettingsPlaces): string | null {
  const userDir = places.configDir || join(places.home, '.claude')
  const managed = places.managedFile ?? MANAGED_FILE
  const dropIns = join(dirname(managed), 'managed-settings.d')
  let dropInFiles: string[] = []
  try {
    dropInFiles = readdirSync(dropIns)
      .filter((n) => n.endsWith('.json'))
      .map((n) => join(dropIns, n))
  } catch {
    // None.
  }
  const files = [managed, ...dropInFiles, join(userDir, 'settings.json'), join(places.cwd, '.claude', 'settings.json'), join(places.cwd, '.claude', 'settings.local.json')]
  const sources: Array<[string, Record<string, unknown> | null]> = [
    ...files.map((file): [string, Record<string, unknown> | null] => [file, readSettings(file)]),
    ...(places.registry ?? registryPolicies).map((p): [string, Record<string, unknown>] => [p.key, p.settings])
  ]
  for (const [where, settings] of sources) {
    if (!settings) continue
    const env = settings.env && typeof settings.env === 'object' ? Object.keys(settings.env) : []
    if (env.some((k) => PROXY_NAMES.test(k))) return `a proxy setting in ${where}`
    const sandbox = settings.sandbox as { enabled?: unknown } | undefined
    if (sandbox?.enabled === true) return `the sandbox, turned on in ${where}`
    if (settings.allowedHttpHookUrls !== undefined) return `allowedHttpHookUrls in ${where}`
  }
  return null
}

/**
 * Claude's managed policy can also be in the registry: JSON in a `Settings` value under these keys (Claude Code's
 * managed-settings docs). Reading it starts reg.exe, so it's read once per app run, off the main thread, and again in
 * the background after half an hour, as Claude itself checks.
 */
const REGISTRY_KEYS = ['HKLM\\SOFTWARE\\Policies\\ClaudeCode', 'HKCU\\SOFTWARE\\Policies\\ClaudeCode']
const REGISTRY_REFRESH_MS = 30 * 60_000

export interface RegistryPolicy {
  key: string
  settings: Record<string, unknown>
}

let registryPolicies: RegistryPolicy[] = []
let registryReadAt = 0
let registryReading: Promise<void> | null = null

/** What `reg query <key> /v Settings` printed, or null when there's no such value. */
export type RegQuery = (key: string) => Promise<string | null>

/** The JSON in reg.exe's answer, or null. */
export function parseRegistrySettings(output: string | null): Record<string, unknown> | null {
  const m = output ? /^\s*Settings\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output) : null
  if (!m) return null
  try {
    const parsed: unknown = JSON.parse(m[1])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function regQuery(key: string): Promise<string | null> {
  return runProgram('reg.exe', ['query', key, '/v', 'Settings'], { env: process.env as Record<string, string>, timeoutMs: 10_000, maxBytes: 1024 * 1024 }).then((r) =>
    r.code === 0 ? r.stdout : null
  )
}

/** Reads the registry policy, the first time waiting for it; later ones answer at once and refresh behind. */
export function loadRegistryPolicy(query: RegQuery = regQuery): Promise<void> {
  if (query === regQuery && process.platform !== 'win32') return Promise.resolve()
  const read = (): Promise<void> =>
    (registryReading ??= Promise.all(REGISTRY_KEYS.map((key) => query(key).then((out) => ({ key, settings: parseRegistrySettings(out) }), () => ({ key, settings: null })))).then((found) => {
      registryPolicies = found.filter((p): p is RegistryPolicy => p.settings !== null)
      registryReadAt = Date.now()
    }).finally(() => {
      registryReading = null
    }))
  if (!registryReadAt) return read()
  if (Date.now() - registryReadAt >= REGISTRY_REFRESH_MS) void read()
  return Promise.resolve()
}

/** The registry policy as last read by loadRegistryPolicy. */
export const registryPolicyNow = (): RegistryPolicy[] => registryPolicies

/** For tests. */
export function forgetRegistryPolicy(): void {
  registryPolicies = []
  registryReadAt = 0
  registryReading = null
}
