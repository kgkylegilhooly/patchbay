import { describe, expect, it } from 'vitest'
import { describeFailure, isLoopback, RETRY_EVERY_MS, RETRY_FOR_MS, type BrowserFailure } from '../../src/shared/browserFailure'
import { createLoadRetry, RELOAD_START_MS } from '../../src/main/browser/loadRetry'

describe('describeFailure', () => {
  it('says nothing is answering yet at a dev server, and that it is worth trying again', () => {
    expect(describeFailure('ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/')).toMatchObject({ title: 'Nothing is answering at 127.0.0.1:5173 yet', retryable: true })
    expect(describeFailure('net::ERR_CONNECTION_REFUSED', 'http://localhost:3000/app')).toMatchObject({ title: 'Nothing is answering at localhost:3000 yet', retryable: true })
  })

  it('does not wait on a server elsewhere', () => {
    expect(describeFailure('ERR_CONNECTION_REFUSED', 'https://example.com/')).toMatchObject({ title: 'Nothing is answering at example.com', retryable: false })
  })

  it('names the host it cannot find', () => {
    expect(describeFailure('ERR_NAME_NOT_RESOLVED', 'http://no-such-host.invalid/')).toMatchObject({ title: "Can't find no-such-host.invalid", retryable: false })
  })

  it('explains a blocked port and offline', () => {
    expect(describeFailure('ERR_UNSAFE_PORT', 'http://127.0.0.1:6000/').title).toBe('Port 6000 is blocked')
    expect(describeFailure('ERR_INTERNET_DISCONNECTED', 'https://example.com/').title).toBe("You're offline")
    expect(describeFailure('ERR_CERT_AUTHORITY_INVALID', 'https://self.signed/').title).toBe('self.signed has a certificate problem')
  })

  it('falls back to the place and nothing more', () => {
    expect(describeFailure('ERR_SOMETHING_NEW', 'https://example.com/x')).toEqual({ title: "Couldn't open example.com", detail: '', retryable: false })
  })

  it('knows loopback addresses', () => {
    for (const url of ['http://localhost:1/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://127.1.2.3:8/', 'http://[::1]:5173/', 'http://0.0.0.0:80/']) expect(isLoopback(url), url).toBe(true)
    for (const url of ['http://example.com/', 'http://10.0.0.1/', 'not a url', 'http://localhost.evil.com/']) expect(isLoopback(url), url).toBe(false)
  })
})

/** A page's loads, with a clock and timers under the test's control. */
function harness() {
  let now = 1_000
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const shown: Array<BrowserFailure | null> = []
  let reloads = 0
  const loads = createLoadRetry<'page'>({
    reload: () => reloads++,
    show: (_p, f) => shown.push(f),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, live: true }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { live: boolean }).live = false
    }
  })
  const advance = (ms: number): void => {
    now += ms
    for (const t of timers) {
      if (t.live && t.at <= now) {
        t.live = false
        t.fn()
      }
    }
  }
  const failLoad = (url = 'http://127.0.0.1:5173/', description = 'ERR_CONNECTION_REFUSED'): void => {
    loads.started('page')
    loads.failed('page', -102, description, url)
    loads.stopped('page')
  }
  const goodLoad = (): void => {
    loads.started('page')
    loads.stopped('page')
  }
  return { loads, shown, advance, failLoad, goodLoad, reloads: () => reloads, liveTimers: () => timers.filter((t) => t.live).length }
}

describe('createLoadRetry', () => {
  it('shows a failed load and tries a dev server again every 2 seconds', () => {
    const h = harness()
    h.failLoad()
    expect(h.shown.at(-1)).toMatchObject({ code: 'ERR_CONNECTION_REFUSED', retryAt: 1_000 + RETRY_EVERY_MS, gaveUp: false })
    h.advance(RETRY_EVERY_MS)
    expect(h.reloads()).toBe(1)
    h.failLoad()
    h.advance(RETRY_EVERY_MS)
    expect(h.reloads()).toBe(2)
  })

  it('clears the failure when the page comes in, and stops trying', () => {
    const h = harness()
    h.failLoad()
    h.advance(RETRY_EVERY_MS)
    h.goodLoad()
    expect(h.shown.at(-1)).toBeNull()
    expect(h.loads.current('page')).toBeNull()
    expect(h.liveTimers()).toBe(0)
  })

  it('gives up after a minute of the same address, and says so', () => {
    const h = harness()
    let tries = 0
    h.failLoad()
    while (h.loads.current('page')?.retryAt) {
      h.advance(RETRY_EVERY_MS)
      h.failLoad()
      tries++
    }
    expect(tries).toBe(RETRY_FOR_MS / RETRY_EVERY_MS)
    expect(h.loads.current('page')).toMatchObject({ retryAt: null, gaveUp: true })
    h.advance(RETRY_EVERY_MS * 5)
    expect(h.reloads()).toBe(tries)
  })

  it('starts a fresh minute after Try again or going somewhere', () => {
    const h = harness()
    h.failLoad()
    h.advance(RETRY_FOR_MS + 1)
    h.failLoad()
    expect(h.loads.current('page')?.gaveUp).toBe(true)
    h.loads.reset('page')
    h.failLoad()
    expect(h.loads.current('page')).toMatchObject({ gaveUp: false, retryAt: expect.any(Number) })
  })

  it('a different address starts its own minute', () => {
    const h = harness()
    h.failLoad('http://127.0.0.1:5173/')
    h.advance(RETRY_FOR_MS + 1)
    h.failLoad('http://127.0.0.1:5174/')
    expect(h.loads.current('page')?.retryAt).not.toBeNull()
  })

  it('does not retry a name that cannot be found', () => {
    const h = harness()
    h.failLoad('http://no-such-host.invalid/', 'ERR_NAME_NOT_RESOLVED')
    expect(h.loads.current('page')).toMatchObject({ retryAt: null, gaveUp: false, title: "Can't find no-such-host.invalid" })
    h.advance(RETRY_EVERY_MS * 3)
    expect(h.reloads()).toBe(0)
  })

  it('ignores a load replaced by another, and a guard refusal', () => {
    const h = harness()
    h.loads.started('page')
    h.loads.failed('page', -3, 'ERR_ABORTED', 'http://127.0.0.1:1/')
    h.loads.failed('page', -20, 'ERR_BLOCKED_BY_CLIENT', 'http://127.0.0.1:1/')
    h.loads.stopped('page')
    expect(h.shown).toEqual([])
  })

  it('keeps the failure from before the node attached, for it to show', () => {
    const h = harness()
    h.failLoad()
    expect(h.loads.current('page')?.title).toBe('Nothing is answering at 127.0.0.1:5173 yet')
  })

  it('forgets a closed page and its timer', () => {
    const h = harness()
    h.failLoad()
    h.loads.forget('page')
    h.advance(RETRY_EVERY_MS)
    expect(h.reloads()).toBe(0)
    expect(h.loads.current('page')).toBeNull()
  })
})

describe('review follow-ups', () => {
  it('a server that dropped the request is said so, and not reloaded on its own', () => {
    expect(describeFailure('ERR_CONNECTION_RESET', 'http://127.0.0.1:5173/')).toMatchObject({ title: 'The server at 127.0.0.1:5173 closed the connection', retryable: false })
    expect(describeFailure('ERR_EMPTY_RESPONSE', 'http://localhost:3000/').retryable).toBe(false)
    const h = harness()
    h.failLoad('http://127.0.0.1:5173/', 'ERR_CONNECTION_RESET')
    h.advance(RETRY_EVERY_MS * 3)
    expect(h.reloads()).toBe(0)
  })

  it('stops saying it is trying when a reload starts no load', () => {
    const h = harness()
    h.failLoad()
    h.advance(RETRY_EVERY_MS)
    expect(h.reloads()).toBe(1)
    expect(h.loads.current('page')?.retryAt).not.toBeNull()
    h.advance(RELOAD_START_MS)
    expect(h.loads.current('page')).toMatchObject({ retryAt: null })
    expect(h.shown.at(-1)?.retryAt).toBeNull()
  })

  it('a reload that starts keeps the retries going', () => {
    const h = harness()
    h.failLoad()
    h.advance(RETRY_EVERY_MS)
    h.failLoad()
    h.advance(RELOAD_START_MS - 1)
    expect(h.loads.current('page')?.retryAt).not.toBeNull()
    expect(h.reloads()).toBeGreaterThanOrEqual(2)
  })
})
