/** What menus can ask of a mounted terminal, which owns its xterm instance. */
export interface TerminalActions {
  hasSelection(): boolean
  copy(): void
  paste(): void
  find(): void
  focus(): void
}

const terminals = new Map<string, TerminalActions>()
let lastFocused: string | null = null

export function registerTerminal(id: string, actions: TerminalActions): () => void {
  terminals.set(id, actions)
  // Asked to have the keyboard before it was built: it takes it now.
  if (takePendingFocus(id)) actions.focus()
  return () => {
    if (terminals.get(id) === actions) terminals.delete(id)
    if (lastFocused === id) lastFocused = null
  }
}

export function noteTerminalFocus(id: string): void {
  lastFocused = id
}

export function terminalActions(id: string): TerminalActions | undefined {
  return terminals.get(id)
}

/** The terminal Edit menu items act on. Opening a menu keeps keyboard focus, so this stays current. */
export function focusedTerminal(): TerminalActions | undefined {
  return lastFocused ? terminals.get(lastFocused) : undefined
}

export function focusedTerminalId(): string | null {
  return lastFocused && terminals.has(lastFocused) ? lastFocused : null
}

/**
 * Focus asked for a terminal not built yet, as when a session in a project not drawn since launch is revealed: new
 * terminals are built a few a frame (mountQueue.ts), so it may not exist when the caller asks. The latest ask wins,
 * lasts `PENDING_FOCUS_MS`, and a click or key elsewhere in the meantime cancels it, so it never steals focus late.
 */
export const PENDING_FOCUS_MS = 3000
let pendingFocus: { id: string; until: number } | null = null
let wanted: ((id: string) => void) | null = null
let cancelHooked = false

/** Told when a focus waits on a terminal, so its build can go first. Set by the terminal builder. */
export function onFocusWanted(cb: (id: string) => void): void {
  wanted = cb
}

/** Gives the terminal the keyboard now, or as soon as it's built. */
export function focusTerminalWhenReady(id: string, now = Date.now()): void {
  const t = terminals.get(id)
  if (t) {
    pendingFocus = null
    t.focus()
    return
  }
  pendingFocus = { id, until: now + PENDING_FOCUS_MS }
  wanted?.(id)
  if (!cancelHooked && typeof window !== 'undefined') {
    cancelHooked = true
    const cancel = (e: Event): void => {
      if (e.isTrusted) pendingFocus = null
    }
    window.addEventListener('pointerdown', cancel, true)
    window.addEventListener('keydown', cancel, true)
  }
}

/** The focus waiting on this terminal, taken. Called when it registers. */
export function takePendingFocus(id: string, now = Date.now()): boolean {
  if (!pendingFocus || pendingFocus.id !== id) return false
  const due = pendingFocus.until >= now
  pendingFocus = null
  return due
}

export function cancelPendingFocus(): void {
  pendingFocus = null
}
