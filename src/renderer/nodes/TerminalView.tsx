import type { SearchAddon } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { bridge } from '../bridge'
import { ContextMenu } from '../Menu'
import type { Point } from '../menus'
import { linkMenu as linkMenuEntries, pathMenu as pathMenuEntries } from '../pathMenu'
import { isDocPath } from '../../shared/reader'
import { openDocument } from '../reader/readerUi'
import { copyText } from '../clipboard'
import { pinFiles } from '../fileShelfActions'
import { fontStack, windowFontSize } from '../prefs'
import { openTerminalBeside, useStore } from '../store'
import { noteTerminalFocus, registerTerminal } from '../terminalRegistry'
import { otherProfiles, pickedProfile } from '../terminalProfilesUi'
import { installZoomCompensation } from '../xtermZoom'
import { parkedIds, useParked } from '../terminalParking'
import { onCanvasTier } from '../terminalPace'
import { buildLiveTerminal, hookShelfToMemory, shelfHolder, terminalMounts, terminalShelf, type LiveTerminal, type TerminalUi } from './liveTerminal'

const SEARCH_COLORS = {
  matchBackground: '#49c2c955',
  matchOverviewRuler: '#49c2c9',
  activeMatchBackground: '#e2b04a',
  activeMatchColorOverviewRuler: '#e2b04a'
}

const NUDGE_MS = 120
/** How long "Link copied." and "Path copied." show. */
const COPIED_SHOWN_MS = 2500

function findCount(query: string, results: { index: number; count: number } | null): string {
  if (!query || !results) return ''
  if (results.count === 0) return 'No matches'
  // Past xterm's highlight limit it reports the count with no position.
  return results.index < 0 ? `${results.count}+ matches` : `${results.index + 1} of ${results.count}`
}

/** Whether a window is on screen now, so its terminal is built ahead of those that aren't. */
function onScreen(host: HTMLElement): boolean {
  const r = host.getBoundingClientRect()
  return r.width > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight
}

export function TerminalView({ nodeId }: { nodeId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const epoch = useStore((s) => s.epochs[nodeId] ?? 0)
  const refresh = useStore((s) => s.refreshes[nodeId] ?? 0)
  const shownRefresh = useRef(refresh)
  // Far off-screen for a while, the terminal is let go to save memory, and drawn again from the session when it's near.
  const parked = useParked(nodeId)
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
  // A confirmation that something copied only needs a moment. Problems stay until they're dismissed.
  useEffect(() => {
    if (!notice || !/^(Link|Path) copied\.$/.test(notice)) return
    const timer = setTimeout(() => setNotice((n) => (n === notice ? null : n)), COPIED_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [notice])
  const [pathMenu, setPathMenu] = useState<{ at: Point; path: string } | null>(null)
  const [linkMenu, setLinkMenu] = useState<{ at: Point; url: string } | null>(null)

  const pathActions = (target: string): Parameters<typeof pathMenuEntries>[0] => {
    const report = (r: { ok: true } | { ok: false; reason: string }): void => setNotice(r.ok ? null : r.reason)
    return {
      open: () => void bridge.openTerminalLink(nodeId, target).then(report),
      newTerminal: (profileId) =>
        void bridge.resolveTerminalPath(nodeId, target).then((r) => {
          report(r)
          if (r.ok) openTerminalBeside(nodeId, r.folder, pickedProfile(profileId))
        }),
      // As last read: Settings and the other menus read the list again when they open.
      profiles: otherProfiles().map((p) => ({ id: p.id, name: p.name })),
      // The full Windows path when the file is there, and what was printed when it isn't, so something always copies.
      copy: () =>
        void bridge.resolveTerminalPath(nodeId, target).then((r) =>
          copyText(r.ok ? r.path : target).then(
            () => setNotice(r.ok ? 'Path copied.' : `Copied as printed. ${r.reason}`),
            (e: unknown) => setNotice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`)
          )
        ),
      reveal: () => void bridge.revealTerminalPath(nodeId, target).then(report),
      // A file icon beside this window, and an entry on the Files shelf. It points at the file; nothing is copied.
      pin: () =>
        void bridge.resolveTerminalPath(nodeId, target).then((r) => {
          report(r)
          const from = useStore.getState().doc?.nodes.find((n) => n.id === nodeId)
          if (r.ok) pinFiles([r.path], { besideId: nodeId }, 'pin', from?.title)
        }),
      ...(isDocPath(target) ? { reader: () => void openDocument(target, { fromNodeId: nodeId }).then(report) } : {})
    }
  }

  const linkActions = (url: string): Parameters<typeof linkMenuEntries>[0] => ({
    open: () => void bridge.openTerminalLink(nodeId, url).then((r) => setNotice(r.ok ? null : r.reason)),
    copy: () =>
      void copyText(url).then(
        () => setNotice('Link copied.'),
        (e: unknown) => setNotice(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`)
      )
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host || parked) return
    hookShelfToMemory()
    const key = `${epoch}:${refresh}`
    const ui: TerminalUi = {
      notice: setNotice,
      pathMenu: (at, path) => setPathMenu({ at, path }),
      linkMenu: (at, url) => setLinkMenu({ at, url }),
      openFind: () => {
        setFindOpen(true)
        queueMicrotask(() => findInputRef.current?.select())
      },
      results: setResults
    }
    // A program that drew its own screen only draws again when told its size changed, so a Refresh nudges it. A plain
    // shell is left alone: the replay is already right, and Git Bash can drop a key typed just after a resize.
    const refreshed = shownRefresh.current !== refresh
    shownRefresh.current = refresh

    let live: LiveTerminal | null = null
    const wiring: Array<() => void> = []
    let nudge: ReturnType<typeof setTimeout> | undefined

    /** Puts the terminal in this window and wires what belongs to this drawing of it. */
    const attach = (l: LiveTerminal, fresh: boolean): void => {
      live = l
      const { term, fit, pacer } = l
      l.ui = ui
      l.offstage = false
      l.inCanvas = !host.closest('.unit-maximized, .unit-in-pane')
      if (term.element && term.element.parentElement !== host) host.appendChild(term.element)
      termRef.current = term
      searchRef.current = l.search
      wiring.push(installZoomCompensation(host))
      const noteFocused = (): void => {
        noteTerminalFocus(nodeId)
        bridge.noteFocus(nodeId)
      }
      const noteBlurred = (): void => bridge.noteFocus(null)
      term.textarea?.addEventListener('focus', noteFocused)
      term.textarea?.addEventListener('blur', noteBlurred)
      wiring.push(() => {
        term.textarea?.removeEventListener('focus', noteFocused)
        term.textarea?.removeEventListener('blur', noteBlurred)
      })
      wiring.push(
        registerTerminal(nodeId, {
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
          find: ui.openFind,
          focus: () => term.focus()
        })
      )
      // Under the pointer it draws at the near pace, and what was held shows at once.
      const enter = (): void => {
        l.hovered = true
        pacer.flush()
      }
      const leave = (): void => {
        l.hovered = false
      }
      host.addEventListener('pointerenter', enter)
      host.addEventListener('pointerleave', leave)
      wiring.push(() => {
        host.removeEventListener('pointerenter', enter)
        host.removeEventListener('pointerleave', leave)
        l.hovered = false
      })
      wiring.push(onCanvasTier(pacer.flush))

      let frame = 0
      const refit = (): void => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (!host.offsetWidth || !host.offsetHeight) return
          fit.fit()
          if (term.cols === l.lastCols && term.rows === l.lastRows) return
          l.lastCols = term.cols
          l.lastRows = term.rows
          l.resizedSinceInput = true
          bridge.resize(nodeId, term.cols, term.rows)
        })
      }
      const observer = new ResizeObserver(refit)
      observer.observe(host)
      refit()
      refitRef.current = refit
      wiring.push(() => {
        observer.disconnect()
        cancelAnimationFrame(frame)
        refitRef.current = null
      })
      // Back from the shelf: what it gathered there is drawn now.
      if (!fresh) pacer.flush()

      if (fresh && refreshed) {
        term.focus()
        nudge = setTimeout(() => {
          const ownScreen = term.buffer.active.type === 'alternate' || useStore.getState().doc?.nodes.find((n) => n.id === nodeId)?.kind === 'claude'
          if (!ownScreen || term.cols < 3) return
          bridge.resize(nodeId, term.cols - 1, term.rows)
          nudge = setTimeout(() => bridge.resize(nodeId, term.cols, term.rows), NUDGE_MS)
        }, NUDGE_MS)
      }
    }

    // Kept from when this window was last drawn (another project's tab, maximized, a Focus view pane), or built anew:
    // those on screen first, a few a frame, so opening a busy project doesn't freeze the window. See mountQueue.ts.
    const kept = terminalShelf.take(nodeId, key)
    const cancel = kept ? null : terminalMounts.request(onScreen(host), () => attach(buildLiveTerminal(nodeId, host, lookRef.current, fontSizeRef.current, ui), true))
    if (kept) attach(kept, false)

    return () => {
      cancel?.()
      clearTimeout(nudge)
      for (const off of wiring.splice(0).reverse()) off()
      const l = live as LiveTerminal | null
      if (!l) return
      const { term } = l
      if (term.textarea === document.activeElement) bridge.noteFocus(null)
      termRef.current = null
      searchRef.current = null
      // Still the same session, just not drawn here now: kept for when it's drawn again, which may be at once.
      const s = useStore.getState()
      const node = s.doc?.nodes.find((n) => n.id === nodeId)
      const same = node && !parkedIds().has(nodeId) && (s.epochs[nodeId] ?? 0) === epoch && (s.refreshes[nodeId] ?? 0) === refresh
      if (!same || !term.element) {
        l.dispose()
        return
      }
      l.search.clearDecorations()
      l.offstage = true
      shelfHolder().appendChild(term.element)
      terminalShelf.keep(nodeId, { value: l, key, projectId: node.projectId ?? null }, s.doc?.activeProjectId ?? null)
    }
  }, [nodeId, epoch, refresh, parked])

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
    <div className="term nodrag nowheel nopan" data-term-node={nodeId}>
      <div className="term-host" ref={hostRef} />
      {parked && <div className="term-parked" data-parked>Unloaded while off-screen</div>}
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
      {linkMenu &&
        createPortal(
          <ContextMenu at={linkMenu.at} label={linkMenu.url} onClose={() => setLinkMenu(null)} entries={linkMenuEntries(linkActions(linkMenu.url))} />,
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
