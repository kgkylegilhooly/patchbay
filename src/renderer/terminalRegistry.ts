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
