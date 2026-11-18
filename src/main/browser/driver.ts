import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, session, webContents, type WebContents } from 'electron'
import { BROWSER_PARTITIONS, checkUrl, LIMITS, partitionFor, TIMEOUTS } from '../../shared/browserPolicy'
import type { BrowserState, BrowserStep, CanvasStore } from '../../shared/contract'
import { RpcRefusal } from '../control/server'
import { lockAttach, lockGuest, lockSession } from './guard'
import type { DesignPick } from '../../shared/design'
import { CANCEL_SOURCE, PICK_SOURCE } from './designPick'
import { pageCall, WORLD_ID } from './pageScripts'

/** What the agent verbs need from a page. Anything they can't do comes back as a refusal saying why. */
export interface BrowserDriver {
  /** Until the canvas has drawn this node's page, or the limit passes. */
  waitReady(id: string, timeoutMs: number): Promise<boolean>
  /** Until the page finishes loading, or the limit passes. Whether it finished. */
  settled(id: string): Promise<boolean>
  page(id: string): { url: string; title: string }
  navigate(id: string, url: string): Promise<boolean>
  step(id: string, step: 'back' | 'forward' | 'reload'): Promise<{ moved: boolean; loaded: boolean }>
  call(id: string, method: 'read' | 'locate' | 'type' | 'scroll', args: Record<string, unknown>): Promise<Record<string, unknown>>
  clickAt(id: string, x: number, y: number): Promise<void>
  pressEnter(id: string): Promise<void>
  /** Design mode: waits for the person to pick an element, however long that takes. Null if they cancel. */
  pick(id: string): Promise<DesignPick | null>
  cancelPick(id: string): Promise<void>
  screenshot(id: string): Promise<{ path: string; width: number; height: number; bytes: number }>
  noteDriving(id: string, by: string, action: string): void
}

const URL_SAVE_MS = 400
const STATE_PUSH_MS = 80
/** Time for a page slid into view to draw again before it takes input or its picture is taken. */
const REVEAL_SETTLE_MS = 250

/**
 * Run in the app window. With `on`, a browser node that's wholly out of view is moved over the top-left of the canvas,
 * nearly transparent and letting clicks through, and true says so. React Flow places nodes with `transform`, so this
 * uses `translate`, which adds to it without touching it. Without `on`, the node goes back.
 */
export function revealForInput(id: string, on: boolean): string {
  return `(() => {
    const node = document.querySelector('.react-flow__node[data-id="' + CSS.escape(${JSON.stringify(id)}) + '"]');
    if (!node) return false;
    if (!${on}) {
      node.style.translate = node.style.opacity = node.style.pointerEvents = '';
      return true;
    }
    const pane = document.querySelector('.react-flow');
    const host = node.querySelector('.browser-host');
    if (!pane || !host) return false;
    const view = pane.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    if (box.right > view.left && box.bottom > view.top && box.left < view.right && box.top < view.bottom) return false;
    const scale = box.width / host.offsetWidth || 1;
    node.style.translate = ((view.left - box.left) / scale) + 'px ' + ((view.top - box.top) / scale) + 'px';
    node.style.opacity = '0.01';
    node.style.pointerEvents = 'none';
    return true;
  })()`
}

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RpcRefusal(`The page took too long ${what}.`)), ms)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

/**
 * Does the work with the node's page in view. Chromium stops drawing a page that's out of view, and then a picture
 * never comes and a form doesn't submit. An agent's browser often opens beyond the visible part of the canvas, so for
 * the moment the work takes, the page is slid into view, all but invisible, and then put back.
 */
async function shown<T>(guest: WebContents, id: string, work: () => Promise<T>): Promise<T> {
  const embedder = guest.hostWebContents
  const revealed = embedder && !embedder.isDestroyed() ? await embedder.executeJavaScript(revealForInput(id, true)).catch(() => false) : false
  try {
    if (revealed) await new Promise((r) => setTimeout(r, REVEAL_SETTLE_MS))
    return await work()
  } finally {
    if (revealed && embedder && !embedder.isDestroyed()) await embedder.executeJavaScript(revealForInput(id, false)).catch(() => {})
  }
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Input through the debugging protocol is real input, and doesn't take the keyboard from whatever the person is using. */
async function withDebugger<T>(guest: WebContents, work: (send: Send) => Promise<T>): Promise<T> {
  const { debugger: dbg } = guest
  const own = !dbg.isAttached()
  if (own) {
    try {
      dbg.attach('1.3')
    } catch (e) {
      throw new RpcRefusal(`Couldn't drive the page: ${(e as Error).message}`)
    }
  }
  try {
    return await work((method, params) => dbg.sendCommand(method, params) as Promise<unknown>)
  } finally {
    if (own && dbg.isAttached()) dbg.detach()
  }
}

export interface LiveBrowserDriver extends BrowserDriver {
  /** Must run before any window exists, so no page is ever without its guards. */
  install(): void
  attach(id: string, contentsId: number, from: WebContents): void
  addressBar(id: string, address: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }>
  ownerStep(id: string, step: BrowserStep): void
  states(): Record<string, BrowserState>
  flush(): Promise<void>
}

export function createBrowserDriver({
  dataDir,
  store,
  push
}: {
  dataDir: string
  store: CanvasStore
  push: (id: string, state: BrowserState | null) => void
}): LiveBrowserDriver {
  const shotsDir = join(dataDir, 'browser-shots')
  const guests = new Map<string, WebContents>()
  const states = new Map<string, BrowserState>()
  const waiting = new Map<string, Array<() => void>>()
  const pushTimers = new Map<string, NodeJS.Timeout>()
  const urlTimers = new Map<string, NodeJS.Timeout>()

  const nodeOf = (id: string) => store.get().nodes.find((n) => n.id === id)
  const idOf = (guest: WebContents | null): string | undefined => {
    for (const [id, g] of guests) if (g === guest) return id
    return undefined
  }
  const guestOf = (id: string): WebContents => {
    const guest = guests.get(id)
    if (!guest || guest.isDestroyed()) throw new RpcRefusal(`Browser node "${id}" isn't showing a page right now.`)
    return guest
  }

  /** A busy page can change a lot at once, and none of it should crowd the canvas. */
  const pushSoon = (id: string): void => {
    if (pushTimers.has(id)) return
    pushTimers.set(
      id,
      setTimeout(() => {
        pushTimers.delete(id)
        push(id, states.get(id) ?? null)
      }, STATE_PUSH_MS)
    )
  }

  const change = (id: string, patch: Partial<BrowserState>): void => {
    const state = states.get(id)
    if (!state) return
    states.set(id, { ...state, ...patch })
    pushSoon(id)
  }

  const refresh = (id: string, guest: WebContents): void => {
    if (guest.isDestroyed()) return
    const history = guest.navigationHistory
    change(id, { url: guest.getURL(), title: guest.getTitle(), loading: guest.isLoading(), canBack: history.canGoBack(), canForward: history.canGoForward() })
  }

  /** A page can change its address as fast as it likes, and each save goes to disk and to every window. */
  const saveUrlSoon = (id: string, guest: WebContents): void => {
    if (urlTimers.has(id)) return
    urlTimers.set(
      id,
      setTimeout(() => {
        urlTimers.delete(id)
        const node = nodeOf(id)
        if (guest.isDestroyed() || node?.kind !== 'browser') return
        const url = guest.getURL()
        if (url !== node.url && url.length <= LIMITS.urlChars && checkUrl(url).ok) store.dispatch({ op: 'patchNode', id, patch: { url } })
      }, URL_SAVE_MS)
    )
  }

  const follow = (id: string, guest: WebContents): void => {
    const update = (): void => refresh(id, guest)
    const moved = (): void => {
      update()
      saveUrlSoon(id, guest)
    }
    // A notice stays through loads the page starts itself, so a blocked escape followed by a redirect still shows.
    guest.on('did-start-loading', update)
    guest.on('did-stop-loading', update)
    guest.on('did-navigate', moved)
    guest.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (isMainFrame) moved()
    })
    guest.on('page-title-updated', update)
    guest.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is a load replaced by another. Refusals have already said why.
      if (isMainFrame && code !== -3 && code !== -20) change(id, { notice: `Couldn't open ${url.slice(0, 200)}: ${description}` })
    })
    guest.on('render-process-gone', (_e, details) => change(id, { notice: `The page stopped working (${details.reason}). Reload to try again.`, loading: false }))
    guest.once('destroyed', () => {
      if (guests.get(id) !== guest) return
      guests.delete(id)
      states.delete(id)
      pushSoon(id)
    })
  }

  const settled = (id: string): Promise<boolean> => settledWithin(id, TIMEOUTS.navigateMs)

  const settledWithin = (id: string, ms: number): Promise<boolean> => {
    const guest = guestOf(id)
    return new Promise((resolve) => {
      const finish = (loaded: boolean): void => {
        clearTimeout(timer)
        if (!guest.isDestroyed()) guest.off('did-stop-loading', stop)
        resolve(loaded)
      }
      const stop = (): void => finish(true)
      const timer = setTimeout(() => finish(false), Math.max(0, ms))
      guest.once('did-stop-loading', stop)
      if (!guest.isLoading()) finish(true)
    })
  }

  const settleAfter = async (id: string): Promise<boolean> => {
    // What was just done may not have started a load yet.
    await new Promise((r) => setTimeout(r, TIMEOUTS.settleMs))
    return guests.get(id)?.isDestroyed() === false ? settled(id) : false
  }

  const load = async (guest: WebContents, url: string): Promise<void> => {
    try {
      await guest.loadURL(url)
    } catch (e) {
      const { code } = e as { code?: string }
      // A page that's replaced as it loads, as with a redirect, rejects like this and is still fine.
      if (code !== 'ERR_ABORTED') throw new RpcRefusal(`Couldn't open ${url}: ${code ?? (e as Error).message}`)
    }
  }

  const trimShots = (): void => {
    const files = readdirSync(shotsDir)
      .map((name) => ({ name, at: statSync(join(shotsDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    for (const old of files.slice(LIMITS.screenshotsKept)) rmSync(join(shotsDir, old.name), { force: true })
  }

  const driver: LiveBrowserDriver = {
    install() {
      for (const partition of BROWSER_PARTITIONS) {
        lockSession(session.fromPartition(partition), (contents, message) => {
          const id = idOf(contents)
          if (id) change(id, { notice: message })
        })
      }
      app.on('web-contents-created', (_e, contents) => {
        contents.on('will-attach-webview', (event, prefs, params) => {
          if (!lockAttach(prefs, params)) event.preventDefault()
        })
        if (contents.getType() !== 'webview') return
        lockGuest(contents, (message) => {
          const id = idOf(contents)
          if (id) change(id, { notice: message })
        })
      })
    },

    attach(id, contentsId, from) {
      const node = nodeOf(id)
      const guest = webContents.fromId(contentsId)
      if (node?.kind !== 'browser' || !guest || guest.getType() !== 'webview') return
      if (guest.hostWebContents !== from || guest.session !== session.fromPartition(partitionFor(node))) return
      guests.set(id, guest)
      states.set(id, { url: guest.getURL() || node.url, title: guest.getTitle(), loading: guest.isLoading(), canBack: false, canForward: false, notice: null, driving: null })
      follow(id, guest)
      pushSoon(id)
      for (const wake of waiting.get(id) ?? []) wake()
      waiting.delete(id)
    },

    waitReady(id, timeoutMs) {
      if (guests.get(id)?.isDestroyed() === false) return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs)
        const wake = (): void => {
          clearTimeout(timer)
          resolve(true)
        }
        waiting.set(id, [...(waiting.get(id) ?? []), wake])
      })
    },

    settled,

    page(id) {
      const guest = guestOf(id)
      return { url: guest.getURL(), title: guest.getTitle() }
    },

    async navigate(id, url) {
      const guest = guestOf(id)
      change(id, { notice: null })
      const started = Date.now()
      let timedOut = false
      await bounded(load(guest, url), TIMEOUTS.navigateMs, 'to load').catch((e) => {
        if (!(e instanceof RpcRefusal) || !e.message.startsWith('The page took')) throw e
        timedOut = true
      })
      if (guest.isDestroyed()) return false
      // The document can be in while the page is still loading what it needs. Answering then said "loaded": false,
      // and an agent went on to use the page before it was ready. It waits for the rest, within the same limit.
      if (timedOut || !guest.isLoading()) return !guest.isLoading()
      return settledWithin(id, TIMEOUTS.navigateMs - (Date.now() - started))
    },

    async step(id, step) {
      const guest = guestOf(id)
      const history = guest.navigationHistory
      if (step === 'back' && !history.canGoBack()) return { moved: false, loaded: true }
      if (step === 'forward' && !history.canGoForward()) return { moved: false, loaded: true }
      change(id, { notice: null })
      if (step === 'back') history.goBack()
      else if (step === 'forward') history.goForward()
      else guest.reload()
      return { moved: true, loaded: await settleAfter(id) }
    },

    call(id, method, args) {
      const guest = guestOf(id)
      return bounded(guest.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: pageCall(method, args) }], true), TIMEOUTS.scriptMs, 'to answer') as Promise<Record<string, unknown>>
    },

    async pick(id) {
      const guest = guestOf(id)
      const picked = await guest.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: PICK_SOURCE }], true)
      return (picked ?? null) as DesignPick | null
    },

    async cancelPick(id) {
      const guest = guestOf(id)
      await bounded(guest.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: CANCEL_SOURCE }], true), TIMEOUTS.scriptMs, 'to answer')
    },

    async clickAt(id, x, y) {
      const guest = guestOf(id)
      const mouse = { x, y, button: 'left', clickCount: 1 }
      await shown(guest, id, () =>
        bounded(
          withDebugger(guest, async (send) => {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse })
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse })
          }),
          TIMEOUTS.scriptMs,
          'to take the click'
        )
      )
      await settleAfter(id)
    },

    async pressEnter(id) {
      const guest = guestOf(id)
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await shown(guest, id, () =>
        bounded(
          withDebugger(guest, async (send) => {
            await send('Emulation.setFocusEmulationEnabled', { enabled: true })
            await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key })
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
          }),
          TIMEOUTS.scriptMs,
          'to take the key'
        )
      )
      await settleAfter(id)
    },

    async screenshot(id) {
      const guest = guestOf(id)
      const { data } = (await shown(guest, id, () =>
        bounded(
          withDebugger(guest, (send) => send('Page.captureScreenshot', { format: 'png' })),
          TIMEOUTS.screenshotMs,
          'to draw a picture. A window that is minimized or hidden may not draw'
        )
      )) as { data: string }
      const png = Buffer.from(data, 'base64')
      if (png.length > LIMITS.screenshotBytes) throw new RpcRefusal(`That picture is over ${LIMITS.screenshotBytes} bytes. Make the node smaller.`)
      mkdirSync(shotsDir, { recursive: true })
      const path = join(shotsDir, `${id.slice(0, 40).replace(/[^\w-]/g, '_')}-${Date.now()}.png`)
      writeFileSync(path, png)
      trimShots()
      return { path, width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length }
    },

    noteDriving(id, by, action) {
      change(id, { driving: { by, action, at: Date.now() } })
    },

    async addressBar(id, address) {
      const checked = checkUrl(address)
      if (!checked.ok) {
        change(id, { notice: checked.reason })
        return checked
      }
      const guest = guests.get(id)
      if (!guest || guest.isDestroyed()) return { ok: false, reason: "This node isn't showing a page right now." }
      change(id, { notice: null })
      // Failures show on the node, from did-fail-load, so the answer here is only about the address.
      void guest.loadURL(checked.url).catch(() => {})
      return checked
    },

    ownerStep(id, step) {
      const guest = guests.get(id)
      if (!guest || guest.isDestroyed()) return
      change(id, { notice: null })
      const history = guest.navigationHistory
      if (step === 'back' && history.canGoBack()) history.goBack()
      if (step === 'forward' && history.canGoForward()) history.goForward()
      if (step === 'reload') guest.reload()
      if (step === 'stop') guest.stop()
    },

    states: () => Object.fromEntries(states),

    async flush() {
      await Promise.all(
        BROWSER_PARTITIONS.map(async (partition) => {
          const ses = session.fromPartition(partition)
          ses.flushStorageData()
          await ses.cookies.flushStore().catch(() => {})
        })
      )
    }
  }
  return driver
}
