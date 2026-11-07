/**
 * What a browser node may load, and the limits on what agents can do in one. It's plain data and checks, shared by the
 * address bar, the agent verbs and the guards on the page itself, so all three give the same answer.
 */

/**
 * Nodes the person opens share one store of sign-ins. Nodes an agent opens share another, so an agent that opens its own
 * browser never finds itself signed in to what the person signed in to. Neither is the app window's own storage.
 */
export const PERSON_PARTITION = 'persist:patchbay-browser'
export const AGENT_PARTITION = 'persist:patchbay-browser-agent'
export const BROWSER_PARTITIONS: readonly string[] = [PERSON_PARTITION, AGENT_PARTITION]

export function partitionFor(node: { openedBy?: string | null }): string {
  return node.openedBy ? AGENT_PARTITION : PERSON_PARTITION
}

export const BLANK = 'about:blank'

export const LIMITS = {
  /** How much of a page's text one read returns, unless asked for less or more up to the most. */
  readChars: 20_000,
  readCharsMost: 100_000,
  /** How many interactive elements one read lists. */
  elements: 200,
  elementName: 120,
  elementValue: 200,
  typeChars: 10_000,
  urlChars: 8_000,
  screenshotBytes: 16 * 1024 * 1024,
  /** Older pictures are removed, so an agent can't fill the disk. */
  screenshotsKept: 50,
  scrollPixels: 100_000
} as const

export const TIMEOUTS = {
  /** A new node's page has to be drawn by the canvas before it can be driven. */
  attachMs: 10_000,
  /** With attachMs, this stays under the 30 seconds the patchbay command waits for an answer. */
  navigateMs: 15_000,
  scriptMs: 8_000,
  screenshotMs: 10_000,
  /** After a click, how long to see whether it started a page load. */
  settleMs: 300
} as const

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string }

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
/** `localhost:3000` reads as a scheme to the URL parser, but nobody means that. */
const HOST_AND_PORT = /^[a-zA-Z0-9.-]+:\d+(?:[/?#]|$)/
const LOOKS_LOCAL = /^(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i

function refused(scheme: string): UrlCheck {
  return { ok: false, reason: `A browser node can only open http, https and about:blank, not ${scheme}.` }
}

/**
 * The one place an address becomes something to load. Takes what a person or an agent gave and returns the full URL, or
 * why not. What comes back is the URL parser's own rewrite, so what was checked is what's loaded.
 */
export function checkUrl(input: string): UrlCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'That address is not text.' }
  const text = input.trim()
  if (!text) return { ok: false, reason: 'Enter an address.' }
  if (text.length > LIMITS.urlChars) return { ok: false, reason: `That address is over ${LIMITS.urlChars} characters.` }
  if (text.toLowerCase() === BLANK) return { ok: true, url: BLANK }
  const schemed = HAS_SCHEME.test(text) && !HOST_AND_PORT.test(text)
  if (!schemed && /\s/.test(text)) return { ok: false, reason: 'That is not an address.' }
  const full = schemed ? text : `${LOOKS_LOCAL.test(text) ? 'http' : 'https'}://${text}`
  let url: URL
  try {
    url = new URL(full)
  } catch {
    return { ok: false, reason: 'That is not an address.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return refused(url.protocol.replace(/:$/, ''))
  if (url.username || url.password) return { ok: false, reason: 'An address with a name or password in it is refused.' }
  if (!url.hostname) return { ok: false, reason: 'That is not an address.' }
  return { ok: true, url: url.href }
}

/** For a load already under way, so the whole URL is there and nothing gets filled in. */
export function isAllowedTopLevel(url: string): boolean {
  if (url === BLANK) return true
  try {
    const { protocol, username, password } = new URL(url)
    return (protocol === 'http:' || protocol === 'https:') && !username && !password
  } catch {
    return false
  }
}

/** A frame inside a page may also hold content the page made itself, which runs with no origin of its own. */
export function isAllowedSubframe(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'about:' || protocol === 'data:' || protocol === 'blob:'
  } catch {
    return false
  }
}

/** What a page may fetch: nothing outside the web, such as files on this PC. */
export function isAllowedSubresource(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:'].includes(protocol)
  } catch {
    return false
  }
}

export type BrowserAccess = 'opened' | 'linked' | null

/** Why an agent can't drive this node, or null if it can. Same rule as read and send, plus the person's hold. */
export function driveRefusal(id: string, access: BrowserAccess, held: boolean | undefined): string | null {
  if (!access) return `Can't drive browser node "${id}": it isn't linked to you and you didn't open it.`
  if (held) return `The person has taken control of browser node "${id}". It stays refused until they hand it back.`
  return null
}
