/**
 * A browser node's page that didn't load, in plain words, and whether it's worth trying again on its own. A dev server
 * that isn't up yet is the common case: the browser beside it should simply show the page once it is.
 * See docs/plans/r3-content.md.
 */

/** What the node shows in place of the white page Chromium leaves after a failed load. */
export interface BrowserFailure {
  url: string
  /** Chromium's own name for it, such as ERR_CONNECTION_REFUSED, shown small for anyone who wants it. */
  code: string
  /** One line, in plain words: "Nothing is answering at 127.0.0.1:5173 yet". */
  title: string
  detail: string
  /** While it's trying again on its own, when the next try is. Null once it has stopped, or never would. */
  retryAt: number | null
  /** Whether it tried on its own and gave up, so the panel can say so. */
  gaveUp: boolean
}

export const RETRY_EVERY_MS = 2_000
/** A dev server that isn't up within a minute probably isn't starting. Try again still works after that. */
export const RETRY_FOR_MS = 60_000

/** Chromium's codes for a load that was replaced by another (-3), or that a guard refused, which already says why (-20). */
export const NOT_A_FAILURE = new Set([-3, -20])

const NOTHING_ANSWERING = new Set(['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_FAILED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_SOCKET_NOT_CONNECTED'])
/** A server is there, and dropped the request: a route that crashed, say. Loading it again on its own wouldn't help. */
const DROPPED = new Set(['ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_EMPTY_RESPONSE'])
const TOO_SLOW = new Set(['ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT'])
const NO_NAME = new Set(['ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED'])

/** This computer: a dev server's address. Only these are tried again on their own. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

/** Host and port as the address bar would show them, or the file's path. */
function placeOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1')
    return u.host || url
  } catch {
    return url.slice(0, 120)
  }
}

/** Chromium's description, without the net:: some versions put in front. */
export function codeName(description: string): string {
  return description.replace(/^net::/, '').trim() || 'ERR_FAILED'
}

/** In plain words, and whether trying again on its own could help. */
export function describeFailure(description: string, url: string): { title: string; detail: string; retryable: boolean } {
  const code = codeName(description)
  const place = placeOf(url)
  const local = isLoopback(url)
  if (NOTHING_ANSWERING.has(code)) {
    return local
      ? { title: `Nothing is answering at ${place} yet`, detail: "If a dev server is starting, the page opens when it's ready.", retryable: true }
      : { title: `Nothing is answering at ${place}`, detail: 'The server may be down, or the address may be wrong.', retryable: false }
  }
  if (DROPPED.has(code)) return { title: `The server at ${place} closed the connection`, detail: "It's running, but didn't send the page. Its own output may say why.", retryable: false }
  if (TOO_SLOW.has(code)) return { title: `${place} took too long to answer`, detail: 'The server may be busy or down.', retryable: local }
  if (NO_NAME.has(code)) return { title: `Can't find ${place}`, detail: 'Check the address: no server goes by that name.', retryable: false }
  if (code === 'ERR_INTERNET_DISCONNECTED') return { title: "You're offline", detail: 'Connect to the internet, then try again.', retryable: false }
  if (code === 'ERR_UNSAFE_PORT') {
    const port = /:(\d+)$/.exec(place)?.[1]
    return { title: `Port ${port ?? 'in that address'} is blocked`, detail: 'Browsers refuse this port because other kinds of server use it. Serve the page on another port.', retryable: false }
  }
  if (code.startsWith('ERR_CERT_') || code.startsWith('ERR_SSL_')) {
    return { title: `${place} has a certificate problem`, detail: "The page isn't shown, as its connection can't be trusted.", retryable: false }
  }
  if (code === 'ERR_FILE_NOT_FOUND') return { title: "That file isn't there", detail: place, retryable: false }
  return { title: `Couldn't open ${place}`, detail: '', retryable: false }
}
