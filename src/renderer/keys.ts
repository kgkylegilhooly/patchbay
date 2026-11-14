/** Keys in the one form bindings are saved and shown in, such as `Ctrl+Shift+T`, `Alt+Left` or `F11`. */

export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey?: boolean
  getModifierState?: (name: string) => boolean
}

const NAMED: Record<string, string> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space', Esc: 'Escape' }
/** With Shift held, `key` gives the shifted character, which depends on the keyboard. These stay the same on any. */
const BY_CODE: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`' }
const MODIFIER_ONLY = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Process', 'Unidentified'])

function baseKey(e: KeyLike): string {
  if (e.shiftKey && e.code) {
    if (e.code.startsWith('Key')) return e.code.slice(3)
    if (e.code.startsWith('Digit')) return e.code.slice(5)
    if (BY_CODE[e.code]) return BY_CODE[e.code]
  }
  const named = NAMED[e.key]
  if (named) return named
  return e.key.length === 1 ? e.key.toUpperCase() : e.key
}

/** Null for a press that isn't a whole key yet, or that's typing a character with AltGr. */
export function keyFromEvent(e: KeyLike): string | null {
  if (MODIFIER_ONLY.has(e.key) || e.metaKey) return null
  if (e.getModifierState?.('AltGraph')) return null
  const mods = [e.ctrlKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean)
  return [...mods, baseKey(e)].join('+')
}

const isFunctionKey = (key: string): boolean => /(^|\+)F([1-9]|1[0-9]|2[0-4])$/.test(key)

/** A key on its own, or with only Shift, is typing. It can't be a shortcut, except for the function keys. */
export function isBindable(key: string): boolean {
  return isFunctionKey(key) || key.startsWith('Ctrl+') || key.startsWith('Alt+')
}

/** The kinds of key the app may take even with a terminal focused, because programs rarely want them. */
export function isAppKey(key: string): boolean {
  return key.startsWith('Ctrl+Shift+') || key.includes('Alt+') || isFunctionKey(key)
}

export type KeyFocus = 'terminal' | 'text' | 'canvas'

/**
 * Whether a bound key goes to the app, given where the keyboard is. On the canvas it always does. In a terminal or a
 * text field the key goes where it was headed, unless it's an app key or `overTerminal` was chosen on purpose.
 * Ctrl+Shift+arrows select by word in a text field, so they stay there.
 */
export function appTakesKey(key: string, focus: KeyFocus, overTerminal: boolean): boolean {
  if (focus === 'canvas' || overTerminal) return true
  if (focus === 'text' && /\+(Left|Right|Up|Down)$/.test(key)) return false
  return isAppKey(key)
}

/** What a press was aimed at, from the element that has the keyboard. */
export function keyFocusOf(target: { closest?: (selector: string) => unknown; tagName?: string; isContentEditable?: boolean } | null): KeyFocus {
  if (target?.closest?.('.xterm')) return 'terminal'
  const tag = target?.tagName
  // A whiteboard keeps Ctrl+Z and the like for its own drawing, as a text field does.
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable || target?.closest?.('[data-own-keys]')) return 'text'
  return 'canvas'
}

/** Handled inside the terminal, and never given up. */
export const TERMINAL_OWNED: Record<string, string> = {
  'Ctrl+C': 'copies a selection, or stops the running program',
  'Ctrl+V': 'pastes into the terminal',
  'Ctrl+F': 'finds in the terminal'
}

const TERMINAL_USES: Record<string, string> = {
  'Ctrl+A': 'moves to the start of the line',
  'Ctrl+B': 'moves back a character',
  'Ctrl+D': 'ends the shell or program',
  'Ctrl+E': 'moves to the end of the line',
  'Ctrl+G': 'cancels a search',
  'Ctrl+H': 'deletes a character',
  'Ctrl+I': 'is Tab',
  'Ctrl+J': 'is Enter',
  'Ctrl+K': 'deletes to the end of the line',
  'Ctrl+L': 'clears the screen',
  'Ctrl+M': 'is Enter',
  'Ctrl+N': 'goes to the next command',
  'Ctrl+O': 'runs the command and shows the next one',
  'Ctrl+P': 'goes to the previous command',
  'Ctrl+Q': 'resumes output',
  'Ctrl+R': 'searches command history',
  'Ctrl+S': 'pauses output',
  'Ctrl+T': 'swaps two characters',
  'Ctrl+U': 'deletes to the start of the line',
  'Ctrl+W': 'deletes a word',
  'Ctrl+X': 'starts a two-key command',
  'Ctrl+Y': 'pastes what was deleted',
  'Ctrl+Z': 'suspends the running program',
  'Ctrl+[': 'is Escape',
  'Ctrl+]': 'is used by some programs to detach',
  'Ctrl+\\': 'force-stops the running program',
  'Ctrl+Left': 'moves back a word',
  'Ctrl+Right': 'moves forward a word',
  'Ctrl+Backspace': 'deletes a word',
  'Ctrl+Delete': 'deletes a word',
  'Alt+B': 'moves back a word',
  'Alt+F': 'moves forward a word',
  'Alt+D': 'deletes a word',
  'Alt+Backspace': 'deletes a word',
  'Alt+.': 'inserts the last argument',
  'Alt+Left': 'moves back a word',
  'Alt+Right': 'moves forward a word'
}

/** What terminals use this key for, if it's something they rely on. */
export function terminalUseOf(key: string): string | null {
  return TERMINAL_OWNED[key] ?? TERMINAL_USES[key] ?? null
}

// Bindings

export interface Bindable {
  id: string
  label: string
  /** The default binding. */
  key?: string
  /** Works in the terminal only, and isn't rebindable. */
  fixedKey?: string
  /** The default key is taken from a focused terminal on purpose, though programs use it too. */
  overTerminal?: boolean
}

/** What's been changed from the defaults. Null means bound to nothing. */
export type Overrides = Record<string, string | null>

export function currentKey(action: Bindable, overrides: Overrides): string | null {
  if (action.fixedKey) return action.fixedKey
  return action.id in overrides ? overrides[action.id] : (action.key ?? null)
}

/** A key someone chose themselves was warned about, so it's taken wherever the keyboard is. */
export function isOverTerminal(action: Bindable, overrides: Overrides): boolean {
  return action.id in overrides ? overrides[action.id] !== null : !!action.overTerminal
}

export function actionForKey<A extends Bindable>(key: string, actions: A[], overrides: Overrides): A | undefined {
  return actions.find((a) => !a.fixedKey && currentKey(a, overrides) === key)
}

export interface KeyProblem {
  /** The other actions already on this key. Choosing it anyway takes it from them. */
  taken: Bindable[]
  /** What terminals use this key for. */
  terminalUse: string | null
  /** The key can't be used at all, and why. */
  refused: string | null
}

export function checkBinding(actionId: string, key: string, actions: Bindable[], overrides: Overrides): KeyProblem {
  const taken = actions.filter((a) => a.id !== actionId && currentKey(a, overrides) === key)
  const owner = TERMINAL_OWNED[key]
  let refused: string | null = null
  if (!isBindable(key)) refused = `${key} is ordinary typing. Use a key with Ctrl or Alt, or a function key.`
  else if (owner) refused = `${key} ${owner}, so it can't be moved.`
  return { taken, terminalUse: terminalUseOf(key), refused }
}

/** Sets the binding, taking the key away from anything else that had it. */
export function bind(actionId: string, key: string, actions: Bindable[], overrides: Overrides): Overrides {
  const next: Overrides = { ...overrides, [actionId]: key }
  for (const a of actions) {
    if (a.id !== actionId && !a.fixedKey && currentKey(a, next) === key) next[a.id] = null
  }
  return clean(next, actions)
}

export function resetBinding(actionId: string, overrides: Overrides): Overrides {
  const { [actionId]: _gone, ...rest } = overrides
  return rest
}

/** A binding that matches its default isn't a change, and shouldn't count as one chosen on purpose. */
function clean(overrides: Overrides, actions: Bindable[]): Overrides {
  const next: Overrides = {}
  for (const [id, key] of Object.entries(overrides)) {
    const action = actions.find((a) => a.id === id)
    if (action && (action.key ?? null) !== key) next[id] = key
  }
  return next
}

/** Saved bindings as far as they can be trusted: anything unknown or unusable is dropped. */
export function sanitizeOverrides(raw: unknown, actions: Bindable[]): Overrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const usable: Overrides = {}
  for (const [id, key] of Object.entries(raw as Record<string, unknown>)) {
    const action = actions.find((a) => a.id === id)
    if (!action || action.fixedKey) continue
    if (key === null) usable[id] = null
    else if (typeof key === 'string' && isBindable(key) && !TERMINAL_OWNED[key]) usable[id] = key
  }
  return clean(usable, actions)
}
