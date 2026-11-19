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
import { BrowserEvidenceStore, EvidenceRefusal } from './evidenceStore'
import { observedViewport, privateScreenshot } from './evidence'
import { VIEWPORTS, type BrowserAttempt, type BrowserDiagnostic, type EvidenceAgent, type EvidenceSummary, type EvidenceViewport, type ViewportPreset } from '../../shared/browserEvidence'
import { randomUUID } from 'node:crypto'
import { EvidenceNetwork } from './evidenceNetwork'
import { linkAttemptToTask, taskRefusal } from './taskLink'
import { readRevision, unknownRevision } from '../tasks/verification'

/** What the agent verbs need from a page. Anything they can't do comes back as a refusal saying why. */
export interface BrowserDriver {
  evidence?: {
    list(id: string): BrowserAttempt[]
    summary(id: string): EvidenceSummary
    diagnostics(id: string, kind: BrowserDiagnostic['kind']): BrowserDiagnostic[]
    /** A named size, or `node` to go back to the node's own size. */
    viewport(id: string, preset: ViewportPreset | 'node'): Promise<EvidenceViewport>
    start(id: string, by: EvidenceAgent, taskId?: string): Promise<BrowserAttempt>
    /** Only the agent that started the attempt can add a step or finish it. */
    capture(id: string, check: () => void, by: EvidenceAgent): Promise<BrowserAttempt[]>
    finish(id: string, assertion: BrowserAttempt['assertion'], by: EvidenceAgent): Promise<BrowserAttempt>
    action(id: string, action: string, state: 'completed' | 'failed', by: EvidenceAgent): void
    interrupt(id: string): void
    image(id: string, attemptId: string, index: number): string | null
  }
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
  const pages = new Map<string, string>()
  const presets = new Map<string, ViewportPreset>()
  // Only a summary goes with the node's state, so a busy page doesn't send its whole record to the window on each push.
  // The panel fetches the attempts when it's open.
  const evidence = new BrowserEvidenceStore(dataDir, (id) => change(id, { evidence: evidence.summary(id) }))
  // Out of the store's own update, as an attempt can end while the canvas is being changed.
  evidence.lifecycle = (attempt) => queueMicrotask(() => linkAttemptToTask(store, attempt))

  /** Back to the node's own size: the person sees the page as it is, and focus emulation from pressing Enter ends. */
  const releaseViewport = async (id: string): Promise<void> => {
    if (!presets.delete(id)) return
    const guest = guests.get(id)
    if (!guest || guest.isDestroyed() || !guest.debugger.isAttached()) return
    await bounded(
      Promise.all([
        guest.debugger.sendCommand('Emulation.clearDeviceMetricsOverride'),
        guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
      ]),
      TIMEOUTS.scriptMs,
      'to go back to its own size'
    ).catch(() => {})
    if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach()
  }

  /** Ends what Take control or a closed node has made impossible to finish, and gives the person back the page's size. */
  store.subscribe((doc) => {
    const stopped = (id: string): boolean => {
      const node = doc.nodes.find((n) => n.id === id)
      return !node || (node.kind === 'browser' && !!node.held)
    }
    for (const a of evidence.recording()) {
      if (stopped(a.nodeId)) evidence.interrupt(a.nodeId, 'Human takeover or node removal interrupted recording.')
      else if (a.startedBy && !doc.nodes.some((n) => n.id === a.startedBy!.id)) {
        evidence.interrupt(a.nodeId, `Its agent "${a.startedBy.title}" was closed, so it can't finish.`)
      }
    }
    for (const id of [...presets.keys()]) if (stopped(id)) void releaseViewport(id)
  })
  // An agent that stops answering leaves its attempt recording. After a while it's marked abandoned.
  setInterval(() => evidence.sweep(), 60_000).unref?.()

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
  const agentCheck = (id: string): void => {
    const node = nodeOf(id)
    if (!node || (node.kind === 'browser' && node.held)) throw new RpcRefusal('The person has taken control or removed the browser.')
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
    pages.set(id, randomUUID())
    guest.debugger.on('detach', () => {
      if (!presets.delete(id)) return
      evidence.gap(id, 'Viewport override was detached; later captures use the node size.')
      change(id, { notice: 'Viewport preset was released. Set it again before continuing the check.' })
    })
    // A new page is a new document arriving. A single-page app moving with pushState, or a load that never arrives,
    // is still the same page.
    guest.on('did-navigate', () => pages.set(id, randomUUID()))
    guest.on('console-message', (details) => {
      if (details.level !== 'error') return
      evidence.diagnostic({ at: Date.now(), nodeId: id, pageId: pages.get(id)!, pageUrl: guest.getURL(), kind: 'console', message: 'Console error (message omitted for privacy).', url: details.sourceId, line: details.lineNumber })
    })
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
      evidence.interrupt(id, 'Page detached; recording stopped. Show the project and start a new attempt.')
      evidence.forgetRecent(id)
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

  /** The page's size as it reports it, within the script limit, so a page stuck in a loop can't hold up the node. */
  const viewportOf = (guest: WebContents): Promise<EvidenceViewport> => bounded(observedViewport(guest), TIMEOUTS.scriptMs, 'to report its size')

  /**
   * A PNG of the page. With a preset, just that area. `mask` hides what's typed in fields, and frames, as evidence
   * pictures do. A plain screenshot shows the page as it is. Everything, the mask included, is within the time limit.
   */
  const picture = async (id: string, mask: boolean): Promise<Buffer> => {
    const guest = guestOf(id)
    const viewport = presets.has(id) ? await viewportOf(guest) : null
    const take = (): Promise<{ data: string }> =>
      shown(guest, id, () =>
        withDebugger(guest, (send) => {
          agentCheck(id)
          const clip = viewport ? { clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 }, captureBeyondViewport: true } : {}
          return send('Page.captureScreenshot', { format: 'png', ...clip }) as Promise<{ data: string }>
        })
      )
    const { data } = await bounded(mask ? privateScreenshot(guest, take) : take(), TIMEOUTS.screenshotMs, 'to draw a picture. A window that is minimized or hidden may not draw')
    return Buffer.from(data, 'base64')
  }

  /** The checkout a browser node's work is in: its worktree group's, else its project's folder. */
  const folderOf = (id: string): string | undefined => {
    const node = nodeOf(id)
    const visited = new Set<string>()
    let parent = node?.parentId ? nodeOf(node.parentId) : undefined
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id)
      if (parent.kind === 'group' && parent.worktree) return parent.worktree.path
      parent = parent.parentId ? nodeOf(parent.parentId) : undefined
    }
    return store.get().projects.find((p) => p.id === (node?.projectId ?? store.get().activeProjectId))?.folder
  }

  /** The evidence store's refusals, as answers to the agent. */
  const refusing = <T,>(work: () => T): T => {
    try {
      return work()
    } catch (e) {
      if (e instanceof EvidenceRefusal) throw new RpcRefusal(e.message)
      throw e
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
        const network = new EvidenceNetwork(contentsId => {
          const guest = webContents.fromId(contentsId)
          const id = guest ? idOf(guest) : undefined
          return id && guest ? { nodeId: id, pageId: pages.get(id)!, pageUrl: guest.getURL(), attemptId: evidence.active(id)?.id ?? null } : undefined
        }, d => evidence.diagnostic(d), id => evidence.gap(id, 'Network tracking limit reached; some failures may be missing.'))
        lockSession(session.fromPartition(partition), (contents, message) => {
          const id = idOf(contents)
          if (id) change(id, { notice: message })
        }, d => network.start(d))
        // These events are distinct from the onBeforeRequest security guard. Never inspect headers or bodies.
        session.fromPartition(partition).webRequest.onErrorOccurred(d => network.end(d, true))
        session.fromPartition(partition).webRequest.onCompleted(d => network.end(d, false))
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
      if (guests.get(id) === guest) return
      guests.set(id, guest)
      states.set(id, { url: guest.getURL() || node.url, title: guest.getTitle(), loading: guest.isLoading(), canBack: false, canForward: false, notice: null, driving: null, evidence: evidence.summary(id) })
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
            agentCheck(id)
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
            agentCheck(id)
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
            agentCheck(id)
            await send('Emulation.setFocusEmulationEnabled', { enabled: true })
            agentCheck(id)
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
      const png = await picture(id, false)
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

    evidence: {
      list: (id) => evidence.list(id),
      summary: (id) => evidence.summary(id),
      diagnostics: (id, kind) => evidence.diagnostics(id, kind),
      async viewport(id, preset) {
        const guest = guestOf(id)
        if (preset === 'node') {
          await releaseViewport(id)
          return await viewportOf(guest)
        }
        const size = VIEWPORTS[preset]
        // Detaching a DevTools session resets emulation. One session is kept while a preset is set, and input and
        // pictures borrow it. It's let go on finish, on Take control, and with --preset node.
        if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
        presets.set(id, preset)
        await bounded(
          guest.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false, screenWidth: size.width, screenHeight: size.height }),
          TIMEOUTS.scriptMs,
          'to change size'
        )
        await new Promise((r) => setTimeout(r, 100))
        return { ...(await viewportOf(guest)), preset }
      },
      async start(id, by, taskId) {
        const node = nodeOf(id)
        if (taskId !== undefined) {
          const refusal = taskRefusal(store.get(), node?.projectId, taskId)
          if (refusal) throw new RpcRefusal(refusal)
        }
        const cwd = folderOf(id)
        const revision = cwd ? await readRevision(cwd).catch(() => unknownRevision('git could not be read')) : unknownRevision('the browser is in no project folder')
        agentCheck(id)
        const guest = guestOf(id)
        const viewport = { ...(await viewportOf(guest)), preset: presets.get(id) }
        return refusing(() => evidence.start({ nodeId: id, projectId: node?.projectId, taskId, url: guest.getURL(), viewport, revision, by }))
      },
      async capture(id, check, by) {
        refusing(() => evidence.owned(id, by))
        const guest = guestOf(id)
        let at = Date.now()
        const pageId = pages.get(id) ?? 'unavailable'
        const url = guest.getURL()
        let viewport: EvidenceViewport = { width: 0, height: 0 }
        try {
          const loaded = await settledWithin(id, 3000)
          check()
          viewport = { ...(await viewportOf(guest)), preset: presets.get(id) }
          check()
          if (!loaded) evidence.gap(id, 'Page was still loading at capture time.')
          at = Date.now()
          const png = await picture(id, true)
          check()
          if (pages.get(id) !== pageId) throw new RpcRefusal('The page changed while the picture was taken.')
          const saved = evidence.savePicture(id, png)
          if ('reason' in saved) evidence.capture(id, { at, pageId, url, viewport, state: 'unavailable', reason: saved.reason })
          else evidence.capture(id, { at, pageId, url, viewport, state: 'available', path: saved.path, width: png.readUInt32BE(16), height: png.readUInt32BE(20), masked: true })
        } catch (e) {
          // Patchbay's own refusals say why, and are safe to keep. Anything else is described, not quoted.
          const why = e instanceof RpcRefusal ? e.message : 'the picture could not be taken'
          if (evidence.active(id)) evidence.capture(id, { at, pageId, url, viewport, state: 'unavailable', reason: `Screenshot unavailable: ${why}` })
        }
        return evidence.list(id)
      },
      async finish(id, assertion, by) {
        const done = refusing(() => evidence.finish(id, assertion, by))
        await releaseViewport(id)
        return done
      },
      action: (id, action, state, by) => evidence.action(id, pages.get(id) ?? 'unavailable', guests.get(id)?.getURL() ?? '', action, state, by),
      interrupt(id) {
        evidence.interrupt(id, 'Agent control interrupted; recording stopped.')
        void releaseViewport(id)
      },
      image: (id, attemptId, index) => evidence.image(id, attemptId, index)
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
      await evidence.flush()
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
