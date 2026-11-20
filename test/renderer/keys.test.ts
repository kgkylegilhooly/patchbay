import { describe, expect, test, vi } from 'vitest'
import { ACTIONS } from '../../src/renderer/actions'
import {
  actionForKey,
  appTakesKey,
  bind,
  checkBinding,
  currentKey,
  isBindable,
  isOverTerminal,
  keyFocusOf,
  keyFromEvent,
  resetBinding,
  sanitizeOverrides,
  terminalUseOf,
  type Bindable
} from '../../src/renderer/keys'
import type { Commands, MenuState } from '../../src/renderer/menus'

// Actions that reach main through the window's bridge, which a test in Node doesn't have. Without these, running every
// action leaves a rejected promise behind, which fails the whole run. Open document… asks main for a file picker.
vi.mock('../../src/renderer/reader/readerUi', () => ({ pickDocument: vi.fn(async () => {}), openDocumentEntry: vi.fn(), openPlanEntry: vi.fn(), readerMenu: vi.fn(() => []) }))
// Jump to next needs-you loads the store on use, which reads the window's bridge too.
vi.mock('../../src/renderer/needsYouUi', async (actual) => ({ ...(await actual<object>()), jumpToNext: vi.fn(async () => {}) }))

const press = (key: string, over: Partial<{ code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; altGr: boolean }> = {}) => ({
  key,
  code: over.code,
  ctrlKey: !!over.ctrl,
  altKey: !!over.alt,
  shiftKey: !!over.shift,
  metaKey: !!over.meta,
  getModifierState: (name: string) => name === 'AltGraph' && !!over.altGr
})

describe('reading a key press', () => {
  test('letters are upper case, with modifiers in one order', () => {
    expect(keyFromEvent(press('k', { ctrl: true }))).toBe('Ctrl+K')
    expect(keyFromEvent(press('T', { ctrl: true, shift: true, code: 'KeyT' }))).toBe('Ctrl+Shift+T')
    expect(keyFromEvent(press('x', { alt: true, ctrl: true }))).toBe('Ctrl+Alt+X')
  })

  test('arrows and punctuation have stable names', () => {
    expect(keyFromEvent(press('ArrowLeft', { ctrl: true, shift: true, code: 'ArrowLeft' }))).toBe('Ctrl+Shift+Left')
    expect(keyFromEvent(press(',', { ctrl: true, code: 'Comma' }))).toBe('Ctrl+,')
    expect(keyFromEvent(press('<', { ctrl: true, shift: true, code: 'Comma' }))).toBe('Ctrl+Shift+,')
    expect(keyFromEvent(press('+', { ctrl: true, shift: true, code: 'Equal' }))).toBe('Ctrl+Shift+=')
    expect(keyFromEvent(press('_', { ctrl: true, shift: true, code: 'Minus' }))).toBe('Ctrl+Shift+-')
    expect(keyFromEvent(press(')', { ctrl: true, shift: true, code: 'Digit0' }))).toBe('Ctrl+Shift+0')
    expect(keyFromEvent(press('F11'))).toBe('F11')
  })

  test('a modifier alone, the Windows key and AltGr typing are not key presses', () => {
    expect(keyFromEvent(press('Control', { ctrl: true }))).toBeNull()
    expect(keyFromEvent(press('Shift', { shift: true }))).toBeNull()
    expect(keyFromEvent(press('k', { meta: true }))).toBeNull()
    expect(keyFromEvent(press('@', { ctrl: true, alt: true, altGr: true }))).toBeNull()
  })
})

describe('what can be bound', () => {
  test('ordinary typing cannot be a shortcut', () => {
    expect(isBindable('K')).toBe(false)
    expect(isBindable('Shift+K')).toBe(false)
    expect(isBindable('Enter')).toBe(false)
    expect(isBindable('Ctrl+K')).toBe(true)
    expect(isBindable('Alt+K')).toBe(true)
    expect(isBindable('F5')).toBe(true)
    expect(isBindable('Shift+F5')).toBe(true)
  })
})

describe('key routing', () => {
  test('with a terminal focused, plain Ctrl keys reach the terminal', () => {
    for (const key of ['Ctrl+C', 'Ctrl+V', 'Ctrl+F', 'Ctrl+Z', 'Ctrl+A', 'Ctrl+Y', 'Ctrl+R', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0']) {
      expect(appTakesKey(key, 'terminal', false)).toBe(false)
    }
  })

  test('with a terminal focused, the app takes Ctrl+Shift, Alt and function keys', () => {
    for (const key of ['Ctrl+Shift+T', 'Ctrl+Shift+Left', 'Alt+X', 'Ctrl+Alt+X', 'F11', 'Shift+F5']) {
      expect(appTakesKey(key, 'terminal', false)).toBe(true)
    }
  })

  test('a key chosen on purpose is taken from a terminal', () => {
    expect(appTakesKey('Ctrl+K', 'terminal', true)).toBe(true)
    expect(appTakesKey('Ctrl+,', 'terminal', true)).toBe(true)
  })

  test('on the canvas the app takes any bound key', () => {
    expect(appTakesKey('Ctrl+Z', 'canvas', false)).toBe(true)
    expect(appTakesKey('Ctrl+A', 'canvas', false)).toBe(true)
  })

  test('text fields keep their own editing keys', () => {
    expect(appTakesKey('Ctrl+Z', 'text', false)).toBe(false)
    expect(appTakesKey('Ctrl+A', 'text', false)).toBe(false)
    expect(appTakesKey('Ctrl+Shift+Left', 'text', false)).toBe(false)
    expect(appTakesKey('Ctrl+Shift+T', 'text', false)).toBe(true)
    expect(appTakesKey('Ctrl+K', 'text', true)).toBe(true)
  })

  test('where the keyboard is comes from the focused element', () => {
    const element = (tagName: string, inTerminal = false, isContentEditable = false) => ({ tagName, isContentEditable, closest: (s: string) => (s === '.xterm' && inTerminal ? {} : null) })
    // xterm's own input is a textarea, which must count as the terminal and not as a text field.
    expect(keyFocusOf(element('TEXTAREA', true))).toBe('terminal')
    expect(keyFocusOf(element('INPUT'))).toBe('text')
    expect(keyFocusOf(element('TEXTAREA'))).toBe('text')
    expect(keyFocusOf(element('DIV', false, true))).toBe('text')
    expect(keyFocusOf(element('BODY'))).toBe('canvas')
    // A whiteboard keeps Ctrl+Z for its own drawing.
    expect(keyFocusOf({ tagName: 'DIV', closest: (s: string) => (s === '[data-own-keys]' ? {} : null) })).toBe('text')
    expect(keyFocusOf(null)).toBe('canvas')
  })
})

describe('bindings', () => {
  const actions: Bindable[] = [
    { id: 'a', label: 'A', key: 'Ctrl+Shift+A' },
    { id: 'b', label: 'B', key: 'Ctrl+Shift+B' },
    { id: 'c', label: 'C' },
    { id: 'copy', label: 'Copy', fixedKey: 'Ctrl+C' },
    { id: 'over', label: 'Over', key: 'Ctrl+K', overTerminal: true }
  ]

  test('the default applies until something changes it', () => {
    expect(currentKey(actions[0], {})).toBe('Ctrl+Shift+A')
    expect(currentKey(actions[0], { a: 'F2' })).toBe('F2')
    expect(currentKey(actions[0], { a: null })).toBeNull()
    expect(currentKey(actions[2], {})).toBeNull()
  })

  test('a key finds its action, and a fixed terminal key never does', () => {
    expect(actionForKey('Ctrl+Shift+B', actions, {})?.id).toBe('b')
    expect(actionForKey('F2', actions, { c: 'F2' })?.id).toBe('c')
    expect(actionForKey('Ctrl+C', actions, {})).toBeUndefined()
    expect(actionForKey('Ctrl+Shift+A', actions, { a: 'F2' })).toBeUndefined()
  })

  test('a conflict names the other action', () => {
    expect(checkBinding('a', 'Ctrl+Shift+B', actions, {}).taken.map((x) => x.id)).toEqual(['b'])
    expect(checkBinding('a', 'Ctrl+Shift+A', actions, {}).taken).toEqual([])
    expect(checkBinding('a', 'F9', actions, {}).taken).toEqual([])
  })

  test('binding a taken key takes it from the other action', () => {
    const next = bind('a', 'Ctrl+Shift+B', actions, {})
    expect(currentKey(actions[0], next)).toBe('Ctrl+Shift+B')
    expect(currentKey(actions[1], next)).toBeNull()
  })

  test('keys terminals rely on carry a warning', () => {
    expect(checkBinding('a', 'Ctrl+R', actions, {}).terminalUse).toMatch(/history/)
    expect(checkBinding('a', 'Alt+B', actions, {}).terminalUse).toMatch(/word/)
    expect(checkBinding('a', 'Ctrl+Shift+Y', actions, {}).terminalUse).toBeNull()
    expect(terminalUseOf('F9')).toBeNull()
  })

  test('the keys the terminal handles itself are refused, as is plain typing', () => {
    for (const key of ['Ctrl+C', 'Ctrl+V', 'Ctrl+F']) expect(checkBinding('a', key, actions, {}).refused).toMatch(/can't be moved/)
    expect(checkBinding('a', 'K', actions, {}).refused).toMatch(/typing/)
    expect(checkBinding('a', 'Ctrl+Q', actions, {}).refused).toBeNull()
  })

  test('a key someone chose is taken from terminals, and an untouched default follows the action', () => {
    expect(isOverTerminal(actions[0], {})).toBe(false)
    expect(isOverTerminal(actions[0], { a: 'Ctrl+R' })).toBe(true)
    expect(isOverTerminal(actions[4], {})).toBe(true)
    expect(isOverTerminal(actions[0], { a: null })).toBe(false)
  })

  test('choosing the default again stops counting as a change', () => {
    expect(bind('a', 'Ctrl+Shift+A', actions, { a: 'F2' })).toEqual({})
  })

  test('reset gives one action its default back and leaves the others', () => {
    expect(resetBinding('a', { a: 'F2', b: 'F3' })).toEqual({ b: 'F3' })
  })

  test('saved bindings that cannot be trusted are dropped', () => {
    expect(sanitizeOverrides({ a: 'F2', b: null, nope: 'F3', c: 'K', copy: 'F4', over: 'Ctrl+C' }, actions)).toEqual({ a: 'F2', b: null })
    expect(sanitizeOverrides('nonsense', actions)).toEqual({})
    expect(sanitizeOverrides(null, actions)).toEqual({})
  })
})

describe('the action registry', () => {
  const state = (over: Partial<MenuState> = {}): MenuState => ({
    selectedCount: 0, canCopy: false, canFind: false, sidebar: true, minimap: true, legend: false, snap: false, canUndo: false, canRedo: false, hasWindow: false, canName: false, canCloseProject: true, ...over
  })

  test('ids are unique', () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length)
  })

  test('no two actions share a default key', () => {
    const keys = ACTIONS.map((a) => a.key).filter(Boolean)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('the defaults asked for are there', () => {
    const key = (id: string) => ACTIONS.find((a) => a.id === id)?.key
    expect(key('open-palette')).toBe('Ctrl+K')
    expect(key('open-settings')).toBe('Ctrl+,')
    expect(key('new-terminal')).toBe('Ctrl+Shift+T')
    expect(key('new-claude')).toBe('Ctrl+Shift+C')
    expect(key('focus-left')).toBe('Ctrl+Shift+Left')
    expect(key('undo')).toBe('Ctrl+Z')
  })

  test('Ctrl+Shift+B is the board, and the git panel has a key of its own that terminals rely on for nothing', () => {
    expect(ACTIONS.filter((a) => a.key === 'Ctrl+Shift+B').map((a) => a.id)).toEqual(['toggle-board'])
    const git = ACTIONS.find((a) => a.id === 'toggle-git')!
    expect(ACTIONS.filter((a) => a.key === git.key)).toHaveLength(1)
    expect(terminalUseOf(git.key!)).toBeNull()
    expect(git.overTerminal).toBeFalsy()
  })

  test('every default key is usable, and only the palette and settings take a plain Ctrl key from terminals', () => {
    for (const a of ACTIONS) if (a.key) expect(isBindable(a.key)).toBe(true)
    const over = ACTIONS.filter((a) => a.overTerminal).map((a) => a.id).sort()
    expect(over).toEqual(['open-palette', 'open-settings'])
  })

  test('with a terminal focused no default touches the keys terminals rely on, apart from those two', () => {
    for (const a of ACTIONS) {
      if (!a.key || a.overTerminal) continue
      if (appTakesKey(a.key, 'terminal', false)) expect(terminalUseOf(a.key), a.key).toBeNull()
    }
  })

  test('each action runs its command', () => {
    const c = new Proxy({} as Commands, { get: (t, k) => ((t as unknown as Record<string, unknown>)[k as string] ??= vi.fn()) })
    for (const a of ACTIONS) expect(() => a.run(c)).not.toThrow()
    expect(c.moveFocus).toHaveBeenCalledWith('left')
    expect(c.stepFont).toHaveBeenCalledWith(1)
    expect(c.stepFont).toHaveBeenCalledWith(-1)
  })

  test('readiness follows the state', () => {
    const ready = (id: string, s: MenuState) => ACTIONS.find((a) => a.id === id)!.ready?.(s) ?? true
    expect(ready('undo', state())).toBe(false)
    expect(ready('undo', state({ canUndo: true }))).toBe(true)
    expect(ready('close-selected', state({ selectedCount: 1 }))).toBe(true)
    expect(ready('name-with-ai', state({ hasWindow: true }))).toBe(false)
    expect(ready('name-with-ai', state({ canName: true }))).toBe(true)
    expect(ready('new-terminal', state())).toBe(true)
  })
})
