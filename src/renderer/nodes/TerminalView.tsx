import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createAttachGate } from '../attachGate'
import { bridge, subscribeOutput } from '../bridge'
import { ContextMenu } from '../Menu'
import type { Point } from '../menus'
import { pathMenu as pathMenuEntries } from '../pathMenu'
import { fontStack, windowFontSize } from '../prefs'
import { openTerminalBeside, useStore } from '../store'
import { noteTerminalFocus, registerTerminal } from '../terminalRegistry'
import { findTerminalPathMatches } from '../terminalPaths'
import { guardFirstKey, isFocusReport } from '../resizeGuard'
import { installZoomCompensation } from '../xtermZoom'

const SEARCH_COLORS = {
  matchBackground: '#49c2c955',
  matchOverviewRuler: '#49c2c9',
  activeMatchBackground: '#e2b04a',
  activeMatchColorOverviewRuler: '#e2b04a'
}

const THEME = {
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

const NUDGE_MS = 120

function findCount(query: string, results: { index: number; count: number } | null): string {
  if (!query || !results) return ''
  if (results.count === 0) return 'No matches'
  // Past xterm's highlight limit it reports the count with no position.
  return results.index < 0 ? `${results.count}+ matches` : `${results.index + 1} of ${results.count}`
}

export function TerminalView({ nodeId }: { nodeId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const epoch = useStore((s) => s.epochs[nodeId] ?? 0)
  const refresh = useStore((s) => s.refreshes[nodeId] ?? 0)
  const shownRefresh = useRef(refresh)
  const fontSize = useStore((s) => windowFontSize(s.doc?.nodes.find((n) => n.id === nodeId)?.fontSize, s.terminalFontSize))
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize
  const look = useStore((s) => s.terminalLook)
  const lookRef = useRef(look)
  lookRef.current = look
  const refitRef = useRef<(() => void) | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pathMenu, setPathMenu] = useState<{ at: Point; path: string } | null>(null)

  const pathActions = (target: string): Parameters<typeof pathMenuEntries>[0] => {
    const report = (r: { ok: true } | { ok: false; reason: string }): void => setNotice(r.ok ? null : r.reason)
    return {
      open: () => void bridge.openTerminalLink(nodeId, target).then(report),
      newTerminal: () =>
        void bridge.resolveTerminalPath(nodeId, target).then((r) => {
          report(r)
          if (r.ok) openTerminalBeside(nodeId, r.folder)
        }),
      copy: () =>
        void bridge.resolveTerminalPath(nodeId, target).then((r) =>
          navigator.clipboard
            .writeText(r.ok ? r.path : target)
            .catch((e: unknown) => setNotice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`))
        ),
      reveal: () => void bridge.revealTerminalPath(nodeId, target).then(report)
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: fontStack(lookRef.current.fontFamily),
      fontSize: fontSizeRef.current,
      lineHeight: 1.15,
      scrollback: lookRef.current.scrollback,
      cursorStyle: lookRef.current.cursorStyle,
      cursorBlink: lookRef.current.cursorBlink,
      allowProposedApi: true,
      theme: THEME
    })
    termRef.current = term
    const fit = new FitAddon()
    const search = new SearchAddon()
    searchRef.current = search
    term.loadAddon(fit)
    term.loadAddon(search)

    const openLink = async (target: string): Promise<void> => {
      const r = await bridge.openTerminalLink(nodeId, target)
      setNotice(r.ok ? null : r.reason)
    }
    term.loadAddon(new WebLinksAddon((_event, uri) => void openLink(uri)))
    const links = term.registerLinkProvider({
      provideLinks(y, callback) {
        // A path printed over ssh is on the other machine, so opening it here would open the wrong file.
        const node = useStore.getState().doc?.nodes.find((n) => n.id === nodeId)
        if (node?.kind === 'terminal' && node.sshHost) return callback(undefined)
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const found = findTerminalPathMatches(text).map((m) => ({
          range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
          text: m.path,
          activate: (event: MouseEvent) => setPathMenu({ at: { x: event.clientX, y: event.clientY }, path: m.path })
        }))
        callback(found.length ? found : undefined)
      }
    })

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey) return true
      const key = ev.key.toLowerCase()
      if (key === 'f' && !ev.shiftKey) {
        setFindOpen(true)
        queueMicrotask(() => findInputRef.current?.select())
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
    const removeZoomFix = installZoomCompensation(host)
    // Set by a resize and cleared by the next key, which may need a byte ahead of it. See resizeGuard.ts.
    let resizedSinceInput = false
    const input = term.onData((data) => {
      // Focus in and out, which the terminal reports once a program asks: not a key, so the guard keeps waiting.
      if (isFocusReport(data)) return bridge.input(nodeId, data)
      const first = resizedSinceInput
      resizedSinceInput = false
      if (!first || useStore.getState().doc?.nodes.find((n) => n.id === nodeId)?.kind !== 'terminal') return bridge.input(nodeId, data)
      const buffer = term.buffer.active
      const row = buffer.getLine(buffer.cursorY + buffer.viewportY)?.translateToString(false, 0, buffer.cursorX) ?? ''
      bridge.input(nodeId, guardFirstKey(data, true, { bracketedPaste: term.modes.bracketedPasteMode, alternateScreen: buffer.type === 'alternate', beforeCursor: row }))
    })
    const noteFocused = (): void => {
      noteTerminalFocus(nodeId)
      bridge.noteFocus(nodeId)
    }
    const unregister = registerTerminal(nodeId, {
      hasSelection: () => term.hasSelection(),
      copy: () => {
        if (!term.hasSelection()) return
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
      },
      paste: () => {
        void navigator.clipboard
          .readText()
          .then((text) => text && term.paste(text))
          .catch((e: unknown) => setNotice(`Couldn't paste: ${e instanceof Error ? e.message : String(e)}`))
      },
      find: () => {
        setFindOpen(true)
        queueMicrotask(() => findInputRef.current?.select())
      },
      focus: () => term.focus()
    })
    const noteBlurred = (): void => bridge.noteFocus(null)
    term.textarea?.addEventListener('focus', noteFocused)
    term.textarea?.addEventListener('blur', noteBlurred)
    // Copy on select: a finished selection goes to the clipboard, as in many terminals.
    const copied = term.onSelectionChange(() => {
      if (lookRef.current.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(() => {})
    })
    const searchResults = search.onDidChangeResults((r) =>
      setResults({ index: r.resultIndex, count: r.resultCount })
    )

    // Each session is attached once: subscribe, then replay the snapshot through the gate.
    const gate = createAttachGate((data) => term.write(data))
    const unsubscribe = subscribeOutput(nodeId, gate.chunk)
    void bridge.attach(nodeId).then(gate.snapshot)

    let lastCols = 0
    let lastRows = 0
    let frame = 0
    const refit = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!host.offsetWidth || !host.offsetHeight) return
        fit.fit()
        if (term.cols === lastCols && term.rows === lastRows) return
        lastCols = term.cols
        lastRows = term.rows
        resizedSinceInput = true
        bridge.resize(nodeId, term.cols, term.rows)
      })
    }
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    refit()
    refitRef.current = refit

    // A program that drew its own screen only draws again when told its size changed, so a Refresh nudges it. A plain
    // shell is left alone: the replay is already right, and Git Bash can drop a key typed just after a resize.
    const refreshed = shownRefresh.current !== refresh
    shownRefresh.current = refresh
    let nudge: ReturnType<typeof setTimeout> | undefined
    if (refreshed) {
      term.focus()
      nudge = setTimeout(() => {
        const ownScreen = term.buffer.active.type === 'alternate' || useStore.getState().doc?.nodes.find((n) => n.id === nodeId)?.kind === 'claude'
        if (!ownScreen || term.cols < 3) return
        bridge.resize(nodeId, term.cols - 1, term.rows)
        nudge = setTimeout(() => bridge.resize(nodeId, term.cols, term.rows), NUDGE_MS)
      }, NUDGE_MS)
    }

    const onPaste = (ev: ClipboardEvent): void => {
      const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (!item || !file) return
      ev.preventDefault()
      ev.stopPropagation()
      void file
        .arrayBuffer()
        .then((buffer) => bridge.savePastedImage(new Uint8Array(buffer), item.type))
        .then((path) => bridge.input(nodeId, /\s/.test(path) ? `"${path}"` : path))
        .catch((e: unknown) => setNotice(`The image wasn't saved: ${e instanceof Error ? e.message : String(e)}`))
    }
    host.addEventListener('paste', onPaste, true)

    return () => {
      clearTimeout(nudge)
      host.removeEventListener('paste', onPaste, true)
      unregister()
      observer.disconnect()
      cancelAnimationFrame(frame)
      unsubscribe()
      input.dispose()
      searchResults.dispose()
      copied.dispose()
      links.dispose()
      removeZoomFix()
      if (term.textarea === document.activeElement) bridge.noteFocus(null)
      term.dispose()
      termRef.current = null
      searchRef.current = null
    }
  }, [nodeId, epoch, refresh])

  // A new look applies to open windows straight away. A font change refits, since the character size changes.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const family = fontStack(look.fontFamily)
    const refit = term.options.fontFamily !== family
    term.options.fontFamily = family
    term.options.cursorStyle = look.cursorStyle
    term.options.cursorBlink = look.cursorBlink
    term.options.scrollback = look.scrollback
    if (refit) refitRef.current?.()
  }, [look])

  // A new font size changes how many characters fit, though the window itself stays the same size.
  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    refitRef.current?.()
  }, [fontSize])

  /** Typing keeps the current match if it still fits, and Enter moves on from it. */
  const find = (backward: boolean, value = query, typing = false): void => {
    const search = searchRef.current
    if (!search) return
    if (!value) {
      search.clearDecorations()
      setResults(null)
      return
    }
    const options = { decorations: SEARCH_COLORS }
    if (backward) search.findPrevious(value, options)
    else search.findNext(value, { ...options, incremental: typing })
  }

  const closeFind = (): void => {
    searchRef.current?.clearDecorations()
    setFindOpen(false)
    setResults(null)
    termRef.current?.focus()
  }

  return (
    <div className="term nodrag nowheel nopan">
      <div className="term-host" ref={hostRef} />
      {findOpen && (
        <form
          className="find"
          role="search"
          onSubmit={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeFind()
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement) find(e.shiftKey)
          }}
        >
          <input
            ref={findInputRef}
            autoFocus
            aria-label="Find in terminal output"
            placeholder="Find"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              find(false, e.target.value, true)
            }}
          />
          <output className="find-count">
            {findCount(query, results)}
          </output>
          <button type="button" aria-label="Previous match" onClick={() => find(true)}>
            ↑
          </button>
          <button type="button" aria-label="Next match" onClick={() => find(false)}>
            ↓
          </button>
          <button type="button" aria-label="Close find" onClick={closeFind}>
            ×
          </button>
        </form>
      )}
      {/* Drawn outside the node, because a zoomed canvas would scale and clip a menu drawn inside it. */}
      {pathMenu &&
        createPortal(
          <ContextMenu at={pathMenu.at} label={pathMenu.path} onClose={() => setPathMenu(null)} entries={pathMenuEntries(pathActions(pathMenu.path))} />,
          document.body
        )}
      {notice && (
        <div className="term-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
