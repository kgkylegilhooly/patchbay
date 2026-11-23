import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { createAttachGate } from '../attachGate'
import { bridge, subscribeOutput } from '../bridge'
import { noteShared } from '../fileShelfActions'
import type { Point } from '../menus'
import { afterNextPaint, createMountQueue, nextFrame } from '../mountQueue'
import { createOutputPacer, type OutputPacer } from '../outputPacer'
import { fontStack } from '../prefs'
import { resourcesBridge } from '../resources/resourcesUi'
import { useStore } from '../store'
import { PARKING } from '../terminalParking'
import { onFocusWanted } from '../terminalRegistry'
import { canvasTier, paceFor } from '../terminalPace'
import { findTerminalPathMatches, linkKind } from '../terminalPaths'
import { createTerminalShelf, SETTLE_MS } from '../terminalShelf'
import type { TerminalLook } from '../prefs'
import { guardFirstKey, isFocusReport } from '../../shared/resizeGuard'
import { screenPoint } from '../xtermZoom'

export const THEME = {
  background: '#161618',
  overviewRulerBorder: '#161618',
  foreground: '#e6e6e8',
  cursor: '#e6e6e8',
  cursorAccent: '#161618',
  selectionBackground: '#3d8bfd66',
  black: '#2c2c30',
  red: '#ff7a6e',
  green: '#62dc8a',
  yellow: '#e2b04a',
  blue: '#7fa8ff',
  magenta: '#e0689b',
  cyan: '#49c2c9',
  white: '#e4e2d8',
  brightBlack: '#6d7790',
  brightRed: '#ff9c92',
  brightGreen: '#8ae9aa',
  brightYellow: '#f0cb7a',
  brightBlue: '#a6c3ff',
  brightMagenta: '#ee92b8',
  brightCyan: '#7dd9de',
  brightWhite: '#f7f5ec'
}

/** What a terminal tells the window drawing it. Each mount of the window puts its own here. */
export interface TerminalUi {
  notice(text: string | null): void
  pathMenu(at: Point, path: string): void
  linkMenu(at: Point, url: string): void
  openFind(): void
  results(r: { index: number; count: number }): void
}

/**
 * A terminal and its session, which outlive the window drawing them: see terminalShelf.ts. What belongs to one
 * drawing of the window (its size watcher, its place in the registry, the zoom fix) is wired by TerminalView.
 */
export interface LiveTerminal {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  pacer: OutputPacer
  ui: TerminalUi
  hovered: boolean
  /** Kept on the shelf, not drawn anywhere. */
  offstage: boolean
  /** On the canvas, so its zoom counts; not maximized or in a Focus view pane. */
  inCanvas: boolean
  lastCols: number
  lastRows: number
  /** Set by a resize and cleared by the next key, which may need a byte ahead of it. See resizeGuard.ts. */
  resizedSinceInput: boolean
  dispose(): void
}

/** Builds the terminal into `host`, subscribes to its session and replays what it has printed so far. */
export function buildLiveTerminal(nodeId: string, host: HTMLElement, look: TerminalLook, fontSize: number, ui: TerminalUi): LiveTerminal {
  // The link under the pointer, of any kind, so a right-click on it offers the link's own menu.
  let hovered: string | null = null
  const term = new Terminal({
    fontFamily: fontStack(look.fontFamily),
    fontSize,
    lineHeight: 1.15,
    scrollback: look.scrollback,
    cursorStyle: look.cursorStyle,
    cursorBlink: look.cursorBlink,
    allowProposedApi: true,
    theme: THEME,
    // Hyperlinks a program prints with OSC 8, as Claude Code does. xterm's own handler asked with confirm() and then
    // called window.open, which this window refuses, so they never opened. They go Patchbay's way instead.
    linkHandler: {
      allowNonHttpProtocols: true,
      activate: (event, uri) => activateLink(event, uri),
      hover: (_event, uri) => {
        hovered = uri
      },
      leave: () => {
        hovered = null
      }
    }
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)

  // Where the pointer really is: the zoom fix rewrites a terminal's mouse events for xterm. See xtermZoom.ts.
  const at = (event: MouseEvent): Point => screenPoint(event)
  /**
   * A left-click on a link: a web link opens, and a path, or a file:// link, offers what can be done with it. xterm
   * calls this on any button's release, so a right-click to copy a link also opened it; only the left button counts.
   */
  const activateLink = (event: MouseEvent, target: string): void => {
    if (event.button !== 0) return
    if (linkKind(target) === 'web') void bridge.openTerminalLink(nodeId, target).then((r) => live.ui.notice(r.ok ? null : r.reason))
    else live.ui.pathMenu(at(event), target)
  }
  const onContextMenu = (event: MouseEvent): void => {
    const target = hovered
    if (!target) return
    // The link's menu instead of the window's own, which a right-click elsewhere in the terminal still opens.
    event.preventDefault()
    event.stopPropagation()
    if (linkKind(target) === 'web') live.ui.linkMenu(at(event), target)
    else live.ui.pathMenu(at(event), target)
  }
  const hoverOptions = {
    hover: (_event: MouseEvent, text: string) => {
      hovered = text
    },
    leave: () => {
      hovered = null
    }
  }
  term.loadAddon(new WebLinksAddon((event, uri) => activateLink(event, uri), hoverOptions))
  const links = term.registerLinkProvider({
    provideLinks(y, callback) {
      // A path printed over ssh is on the other machine, so opening it here would open the wrong file.
      const node = useStore.getState().doc?.nodes.find((n) => n.id === nodeId)
      if (node?.kind === 'terminal' && node.sshHost) return callback(undefined)
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const found = findTerminalPathMatches(text).map((m) => ({
        range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
        text: m.path,
        activate: (event: MouseEvent) => activateLink(event, m.path),
        ...hoverOptions
      }))
      callback(found.length ? found : undefined)
    }
  })

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey) return true
    const key = ev.key.toLowerCase()
    if (key === 'f' && !ev.shiftKey) {
      live.ui.openFind()
      return false
    }
    // Leave the browser to fire its paste event, rather than sending ^V to the program.
    if (key === 'v') return false
    if (key === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    return true
  })

  term.open(host)
  // Its real size before any output is written: a replay drawn at xterm's default 80x24 and then refitted garbles a
  // shell's redrawn lines. The program is told the size by the window's own refit, which follows.
  if (host.offsetWidth && host.offsetHeight) fit.fit()
  const element = term.element!
  // On the terminal's own element rather than the window's, so they go with it wherever it's drawn.
  element.addEventListener('contextmenu', onContextMenu, true)
  const input = term.onData((data) => {
    // Focus in and out, which the terminal reports once a program asks: not a key, so the guard keeps waiting.
    if (isFocusReport(data)) return bridge.input(nodeId, data)
    const first = live.resizedSinceInput
    live.resizedSinceInput = false
    if (!first || useStore.getState().doc?.nodes.find((n) => n.id === nodeId)?.kind !== 'terminal') return bridge.input(nodeId, data)
    const buffer = term.buffer.active
    const row = buffer.getLine(buffer.cursorY + buffer.viewportY)?.translateToString(false, 0, buffer.cursorX) ?? ''
    bridge.input(nodeId, guardFirstKey(data, true, { bracketedPaste: term.modes.bracketedPasteMode, alternateScreen: buffer.type === 'alternate', beforeCursor: row }))
  })
  // Copy on select: a finished selection goes to the clipboard, as in many terminals.
  const copied = term.onSelectionChange(() => {
    if (useStore.getState().terminalLook.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(() => {})
  })
  const searchResults = search.onDidChangeResults((r) => live.ui.results({ index: r.resultIndex, count: r.resultCount }))

  const onPaste = (ev: ClipboardEvent): void => {
    const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (!item || !file) return
    ev.preventDefault()
    ev.stopPropagation()
    void file
      .arrayBuffer()
      .then((buffer) => bridge.savePastedImage(new Uint8Array(buffer), item.type))
      .then((path) => {
        const from = useStore.getState().doc?.nodes.find((n) => n.id === nodeId)
        noteShared(from?.projectId, [path], 'paste', from?.title)
        return bridge.input(nodeId, /\s/.test(path) ? `"${path}"` : path)
      })
      .catch((e: unknown) => live.ui.notice(`The image wasn't saved: ${e instanceof Error ? e.message : String(e)}`))
  }
  element.addEventListener('paste', onPaste, true)

  // Each session is attached once: subscribe, then replay the snapshot through the gate. Output is drawn at a pace
  // that depends on how much of the terminal you can see (terminalPace.ts); the one being typed in draws at once.
  const focused = (): boolean => term.textarea === document.activeElement
  const pacer = createOutputPacer(
    (data) => term.write(data),
    focused,
    () => paceFor({ focused: false, hovered: live.hovered, tier: live.inCanvas ? canvasTier() : 'near', offstage: live.offstage })
  )
  term.textarea?.addEventListener('focus', pacer.flush)
  const gate = createAttachGate((data) => pacer.write(data))
  const unsubscribe = subscribeOutput(nodeId, gate.chunk)
  void bridge.attach(nodeId).then(gate.snapshot)

  const live: LiveTerminal = {
    term,
    fit,
    search,
    pacer,
    ui,
    hovered: false,
    offstage: false,
    inCanvas: true,
    lastCols: 0,
    lastRows: 0,
    resizedSinceInput: false,
    dispose() {
      element.removeEventListener('paste', onPaste, true)
      element.removeEventListener('contextmenu', onContextMenu, true)
      unsubscribe()
      pacer.dispose()
      input.dispose()
      searchResults.dispose()
      copied.dispose()
      links.dispose()
      term.dispose()
    }
  }
  return live
}

/** Where kept terminals wait: in the page, so they keep their state, but off-screen, so xterm stops drawing them. */
let holder: HTMLElement | null = null
export function shelfHolder(): HTMLElement {
  if (holder?.isConnected) return holder
  holder = document.createElement('div')
  holder.className = 'term-shelf'
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:800px;height:600px;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict'
  document.body.appendChild(holder)
  return holder
}

/**
 * At most this many kept, holding about this much history between them; past that the one kept longest ago goes.
 * Enough for a busy project's terminals with ordinary scrollback. Measured (termshelf-memory.cjs), a kept terminal
 * costs the window about twice its weight below: eight with full 10,000-line scrollbacks held ~100 MB. So 128 MB of
 * weight is about 250 MB at most, the same order as the project on show. See terminalShelf.ts.
 */
export const SHELF_BUDGET = { maxCount: 32, maxBytes: 128 * 1024 * 1024 }
/** About 12 bytes a character cell, for every line xterm holds, as terminalParking.ts reckons. */
export const weighTerminal = (t: LiveTerminal): number => (t.term.buffer.normal.length + t.term.rows) * t.term.cols * 12
/**
 * Terminals let go of a few a frame, not all at once: leaving a project past the budget dropped a dozen inside the
 * switch's own frame. Each stops taking output at once; tearing down its xterm waits its turn.
 */
const letGo: LiveTerminal[] = []
function disposeSoon(t: LiveTerminal): void {
  t.pacer.dispose()
  letGo.push(t)
  if (letGo.length === 1) nextFrame(drainLetGo)
}
function drainLetGo(): void {
  const start = performance.now()
  while (letGo.length && performance.now() - start < 4) letGo.shift()!.dispose()
  if (letGo.length) nextFrame(drainLetGo)
}
export const terminalShelf = createTerminalShelf<LiveTerminal>(disposeSoon, () => PARKING.afterMs, undefined, {
  ...SHELF_BUDGET,
  weigh: weighTerminal,
  settle: (check) => void setTimeout(() => afterNextPaint(() => afterNextPaint(check)), SETTLE_MS)
})
let lowMemoryHooked = false
/** Memory short: kept terminals go first, before any on the canvas is unloaded. */
export function hookShelfToMemory(): void {
  if (lowMemoryHooked) return
  lowMemoryHooked = true
  resourcesBridge()?.onLowMemory(() => terminalShelf.clear())
}

export const terminalMounts = createMountQueue(nextFrame, () => performance.now())
// A terminal about to be given the keyboard is built before the rest.
onFocusWanted((id) => terminalMounts.prioritize(id))
