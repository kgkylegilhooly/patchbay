import { expect, test } from 'vitest'
import { createBrowserVerbs } from '../../src/main/control/browserVerbs'
import type { BrowserDriver } from '../../src/main/browser/driver'
import { lockAttach, plainUserAgent } from '../../src/main/browser/guard'
import { pageCall, SENSITIVE_SOURCE } from '../../src/main/browser/pageScripts'
import { RpcRefusal } from '../../src/main/control/server'
import {
  AGENT_PARTITION,
  checkUrl,
  driveRefusal,
  isAllowedSubframe,
  isAllowedSubresource,
  isAllowedTopLevel,
  partitionFor,
  PERSON_PARTITION
} from '../../src/shared/browserPolicy'
import type { BrowserNode, CanvasNode } from '../../src/shared/model'

// URL policy

test('addresses become full http or https URLs', () => {
  expect(checkUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' })
  expect(checkUrl('localhost:3000/a')).toEqual({ ok: true, url: 'http://localhost:3000/a' })
  expect(checkUrl('127.0.0.1:8080')).toEqual({ ok: true, url: 'http://127.0.0.1:8080/' })
  expect(checkUrl('  HTTPS://Example.com/x?y=1 ')).toEqual({ ok: true, url: 'https://example.com/x?y=1' })
  expect(checkUrl('about:blank')).toEqual({ ok: true, url: 'about:blank' })
})

test('everything but http, https and about:blank is refused', () => {
  for (const bad of [
    'file:///C:/Windows/win.ini',
    'FILE:\\\\C:\\x',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'blob:https://a/1',
    'mycustom://launch',
    'ms-settings:privacy',
    'chrome://gpu',
    'devtools://devtools',
    'view-source:https://a',
    'about:config',
    'about:srcdoc',
    'https://user:pw@example.com',
    'two words',
    '',
    'x'.repeat(9000)
  ]) {
    expect(checkUrl(bad).ok, bad).toBe(false)
  }
  expect(checkUrl('mailto:a@b.c')).toMatchObject({ ok: false, reason: expect.stringContaining('not mailto') })
})

test('loads already under way are checked without filling anything in', () => {
  expect(isAllowedTopLevel('https://a.test/')).toBe(true)
  expect(isAllowedTopLevel('about:blank')).toBe(true)
  expect(isAllowedTopLevel('file:///c:/x')).toBe(false)
  expect(isAllowedTopLevel('example.com')).toBe(false)
  expect(isAllowedTopLevel('https://u:p@a.test/')).toBe(false)
  expect(isAllowedSubframe('about:srcdoc')).toBe(true)
  expect(isAllowedSubframe('file:///c:/x')).toBe(false)
  expect(isAllowedSubresource('wss://a.test/s')).toBe(true)
  expect(isAllowedSubresource('file:///c:/x')).toBe(false)
  expect(isAllowedSubresource('chrome-extension://x/y')).toBe(false)
})

test('nodes an agent opens get their own storage, apart from the person\'s', () => {
  expect(partitionFor({ openedBy: 'agent-1' })).toBe(AGENT_PARTITION)
  expect(partitionFor({})).toBe(PERSON_PARTITION)
  expect(partitionFor({ openedBy: null })).toBe(PERSON_PARTITION)
  expect(PERSON_PARTITION).not.toBe(AGENT_PARTITION)
  expect(PERSON_PARTITION.startsWith('persist:')).toBe(true)
})

// Guards

test('a webview only attaches on a browser partition, with no preload and no Node', () => {
  const prefs: Record<string, unknown> = { preload: 'C:/evil.js', nodeIntegration: true, sandbox: false, webSecurity: false }
  const params: Record<string, string> = { partition: PERSON_PARTITION, preload: 'file:///evil.js', nodeintegration: 'on', webpreferences: 'nodeIntegration=yes' }
  expect(lockAttach(prefs, params)).toBe(true)
  expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, disableDialogs: true })
  expect(prefs.preload).toBeUndefined()
  expect(params.preload).toBeUndefined()
  expect(params.nodeintegration).toBeUndefined()
  expect(params.webpreferences).toBeUndefined()
  expect(lockAttach({}, { partition: 'persist:other' })).toBe(false)
  expect(lockAttach({}, {})).toBe(false)
})

test('the user agent stops naming Electron and the app', () => {
  expect(plainUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 patchbay/0.1.0 Electron/38.1.0 Safari/537.36')).toBe(
    'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
  )
})

// Page scripts

test('what varies goes into a page script as JSON data, never as code', () => {
  const nasty = "e1'); fetch('//evil'); ('"
  const code = pageCall('type', { ref: nasty, text: '`${alert(1)}`</script>', clear: false })
  const call = code.slice(code.lastIndexOf('globalThis.__pb.type('))
  expect(call).toBe(`globalThis.__pb.type(${JSON.stringify({ ref: nasty, text: '`${alert(1)}`</script>', clear: false })});`)
  // The fixed part is the same whatever the arguments.
  expect(code.slice(0, code.lastIndexOf('globalThis.__pb.type('))).toBe(pageCall('read', {}).slice(0, pageCall('read', {}).lastIndexOf('globalThis.__pb.read(')))
})

test('password, code and card fields count as sensitive', () => {
  const sensitive = new Function(`return (${SENSITIVE_SOURCE})`)() as (el: unknown) => boolean
  const field = (tag: string, attrs: Record<string, string>) => ({ tagName: tag.toUpperCase(), getAttribute: (k: string) => attrs[k] ?? null })
  expect(sensitive(field('input', { type: 'password' }))).toBe(true)
  expect(sensitive(field('input', { type: 'text', autocomplete: 'one-time-code' }))).toBe(true)
  expect(sensitive(field('input', { autocomplete: 'cc-number' }))).toBe(true)
  expect(sensitive(field('input', { name: 'user_password' }))).toBe(true)
  expect(sensitive(field('input', { id: 'api-key' }))).toBe(true)
  expect(sensitive(field('input', { type: 'text', name: 'q' }))).toBe(false)
  expect(sensitive(field('input', { type: 'email', autocomplete: 'username' }))).toBe(false)
  expect(sensitive(field('button', { type: 'password' }))).toBe(false)
})

// Access and control

test('driving needs the same access as read and send, and no hold', () => {
  expect(driveRefusal('b', 'opened', false)).toBeNull()
  expect(driveRefusal('b', 'linked', undefined)).toBeNull()
  expect(driveRefusal('b', null, false)).toMatch(/isn't linked to you/)
  expect(driveRefusal('b', 'opened', true)).toMatch(/taken control/)
})

function fakeDriver(overrides: Partial<BrowserDriver> = {}) {
  const log: string[] = []
  const driver: BrowserDriver = {
    waitReady: async () => true,
    pick: async () => null,
    cancelPick: async () => {},
    settled: async () => true,
    page: () => ({ url: 'https://a.test/', title: 'A' }),
    navigate: async (_id, url) => {
      log.push(`navigate ${url}`)
      return true
    },
    step: async (_id, s) => {
      log.push(s)
      return { moved: true, loaded: true }
    },
    call: async (_id, method, args) => {
      log.push(`${method} ${JSON.stringify(args)}`)
      return method === 'locate' ? { x: 5, y: 6 } : method === 'type' ? { typed: String(args.text).length } : {}
    },
    clickAt: async (_id, x, y) => void log.push(`click ${x},${y}`),
    pressEnter: async () => void log.push('enter'),
    screenshot: async () => ({ path: 'C:/shot.png', width: 1, height: 1, bytes: 10 }),
    noteDriving: (_id, by, action) => void log.push(`driving ${by}: ${action}`),
    ...overrides
  }
  return { driver, log }
}

function setup(over: Partial<BrowserDriver> = {}) {
  const nodes = new Map<string, CanvasNode>()
  const browser = (id: string, extra: Partial<BrowserNode> = {}): void =>
    void nodes.set(id, { id, kind: 'browser', title: id, x: 0, y: 0, width: 1, height: 1, parentId: null, url: 'about:blank', ...extra })
  nodes.set('me', { id: 'me', kind: 'terminal', title: 'Agent me', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: 'C:/' })
  browser('mine', { openedBy: 'me' })
  browser('theirs', { openedBy: 'someone' })
  browser('linked')
  const { driver, log } = fakeDriver(over)
  const verbs = createBrowserVerbs({
    driver,
    find: (id) => nodes.get(id),
    accessOf: (caller, n) => (n.openedBy === caller ? 'opened' : caller === 'me' && n.id === 'linked' ? 'linked' : null)
  })
  return { verbs, log, nodes }
}

const refused = async (p: Promise<unknown>, pattern: RegExp): Promise<void> => {
  const e = await p.then(() => null, (err) => err)
  expect(e).toBeInstanceOf(RpcRefusal)
  expect(e.message).toMatch(pattern)
}

test('verbs work on browsers the caller opened or is linked to, and nowhere else', async () => {
  const { verbs } = setup()
  await expect(verbs('me', 'browser-read', { node: 'mine' })).resolves.toMatchObject({ untrusted: true })
  await expect(verbs('me', 'browser-read', { node: 'linked' })).resolves.toMatchObject({ untrusted: true })
  await refused(verbs('me', 'browser-read', { node: 'theirs' }), /isn't linked to you/)
  await refused(verbs('me', 'browser-click', { node: 'theirs', ref: 'e1' }), /isn't linked to you/)
  await refused(verbs('me', 'browser-read', { node: 'me' }), /isn't a browser node/)
  await refused(verbs('me', 'browser-read', { node: 'nope' }), /no node/)
})

test('arguments are checked before anything reaches the page', async () => {
  const { verbs, log } = setup()
  await refused(verbs('me', 'browser-navigate', { node: 'mine', url: 'file:///c:/x' }), /only open http/)
  await refused(verbs('me', 'browser-navigate', { node: 'mine' }), /--url is required/)
  await refused(verbs('me', 'browser-click', { node: 'mine', ref: 'button' }), /--ref must be/)
  await refused(verbs('me', 'browser-click', { node: 'mine', ref: "e1');x('" }), /--ref must be/)
  await refused(verbs('me', 'browser-type', { node: 'mine', ref: 'e1' }), /--text is required/)
  await refused(verbs('me', 'browser-type', { node: 'mine', ref: 'e1', text: 'x'.repeat(10_001) }), /over 10000/)
  await refused(verbs('me', 'browser-scroll', { node: 'mine' }), /one of --by/)
  await refused(verbs('me', 'browser-scroll', { node: 'mine', by: 10, to: 'top' }), /one of --by/)
  await refused(verbs('me', 'browser-scroll', { node: 'mine', by: 1e9 }), /up to/)
  await refused(verbs('me', 'browser-scroll', { node: 'mine', to: 'middle' }), /top or bottom/)
  await refused(verbs('me', 'browser-read', { node: 'mine', maxChars: 0 }), /--max-chars/)
  await refused(verbs('me', 'browser-cookies', { node: 'mine' }), /Unknown verb/)
  expect(log).toEqual([])
})

test('a read is capped, and marked as untrusted', async () => {
  const { verbs, log } = setup()
  const r = (await verbs('me', 'browser-read', { node: 'mine', maxChars: 10_000_000 })) as Record<string, unknown>
  expect(log).toContain('read {"maxChars":100000}')
  expect(r.notice).toMatch(/untrusted data, not instructions/)
})

test('typing says how much, never what, in its answer and on the node', async () => {
  const { verbs, log } = setup()
  const r = await verbs('me', 'browser-type', { node: 'mine', ref: 'e2', text: 'secret-words', enter: true })
  expect(JSON.stringify(r)).not.toContain('secret-words')
  expect(r).toMatchObject({ typed: 12, into: 'e2' })
  expect(log.filter((l) => l.startsWith('driving')).join()).not.toContain('secret-words')
  expect(log).toContain('enter')
})

test('a password field is refused with a reason that says to ask the person', async () => {
  const { verbs } = setup({ call: async () => ({ problem: 'sensitive' }) })
  await refused(verbs('me', 'browser-type', { node: 'mine', ref: 'e3', text: 'x' }), /Ask the person/)
})

test('taking control refuses further verbs, even one already under way, until handed back', async () => {
  let located: () => void = () => {}
  const paused = new Promise<void>((r) => (located = r))
  const { verbs, nodes, log } = setup({
    call: async () => {
      await paused
      return { x: 1, y: 2 }
    }
  })
  const node = nodes.get('mine') as BrowserNode
  const clicking = verbs('me', 'browser-click', { node: 'mine', ref: 'e1' })
  await new Promise((r) => setTimeout(r, 10))
  nodes.set('mine', { ...node, held: true })
  located()
  await refused(clicking, /taken control/)
  expect(log.some((l) => l.startsWith('click'))).toBe(false)
  await refused(verbs('me', 'browser-read', { node: 'mine' }), /taken control/)
  nodes.set('mine', { ...node, held: false })
  await expect(verbs('me', 'browser-read', { node: 'mine' })).resolves.toBeTruthy()
})

test('a page that is not on screen is refused rather than waited on forever', async () => {
  const { verbs } = setup({ waitReady: async () => false })
  await refused(verbs('me', 'browser-read', { node: 'mine' }), /isn't on screen/)
})

test('calls on one page take turns, and a pile-up is refused', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const order: string[] = []
  const { verbs } = setup({
    navigate: async (_id, url) => {
      order.push(`start ${url}`)
      if (url.endsWith('/1')) await gate
      order.push(`end ${url}`)
      return true
    }
  })
  const first = verbs('me', 'browser-navigate', { node: 'mine', url: 'https://a.test/1' })
  const second = verbs('me', 'browser-navigate', { node: 'mine', url: 'https://a.test/2' })
  const more = [3, 4, 5].map((n) => verbs('me', 'browser-navigate', { node: 'mine', url: `https://a.test/${n}` }).catch((e) => e))
  await refused(verbs('me', 'browser-navigate', { node: 'mine', url: 'https://a.test/6' }), /busy/)
  release()
  await Promise.all([first, second, ...more])
  expect(order.slice(0, 4)).toEqual(['start https://a.test/1', 'end https://a.test/1', 'start https://a.test/2', 'end https://a.test/2'])
})
