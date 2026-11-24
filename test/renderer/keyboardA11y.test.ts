import { describe, expect, test, vi } from 'vitest'
import { ACTIONS, actionReady } from '../../src/renderer/actions'
import { actionForKey, appTakesKey, isOverTerminal } from '../../src/renderer/keys'
import type { Commands, MenuState } from '../../src/renderer/menus'
import { kindName, nodeAriaLabel } from '../../src/renderer/a11y/nodeLabel'
import { nextStop, REGION_ORDER } from '../../src/renderer/a11y/regions'
import { helpWords } from '../../src/renderer/a11y/keyHints'
import { alertOf, AnnounceQueue, GAP_MS, joinAlerts, newAlerts, REPEAT_MS, type Alert } from '../../src/renderer/a11y/announce'
import { keyOf, withKey } from '../../src/renderer/a11y/keyHints'
import { closeQuestion } from '../../src/renderer/a11y/nodeLabel'
import { windowFor } from '../../src/renderer/a11y/keyboardAt'
import { trapsTab, windowEscCloses } from '../../src/renderer/shell/panelKeys'
import { toFlow } from '../../src/renderer/flowMapping'
import type { AgentStop } from '../../src/shared/agentStop'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

vi.mock('../../src/renderer/reader/readerUi', () => ({ pickDocument: vi.fn(async () => {}), openDocumentEntry: vi.fn(), openPlanEntry: vi.fn(), readerMenu: vi.fn(() => []) }))
vi.mock('../../src/renderer/needsYouUi', async (actual) => ({ ...(await actual<object>()), jumpToNext: vi.fn(async () => {}) }))

const claude = (over: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id: 'c', kind: 'claude', title: 'Fix the login', x: 0, y: 0, width: 400, height: 300, parentId: null, cwd: 'C:\\repo', prompt: '', sessionId: null, transcriptPath: null, after: [], projectId: 'p1', ...over }) as CanvasNode

const state = (over: Partial<MenuState> = {}): MenuState => ({
  selectedCount: 0,
  canCopy: false,
  canFind: false,
  sidebar: true,
  minimap: true,
  legend: false,
  snap: false,
  canUndo: false,
  canRedo: false,
  hasWindow: false,
  canName: false,
  canCloseProject: false,
  ...over
})

describe('#6 a window has one name for a screen reader', () => {
  test('title, kind and status, in that order', () => {
    expect(nodeAriaLabel(claude(), 'needs-you')).toBe('Fix the login, Claude Code, Needs you')
    expect(nodeAriaLabel(claude({ agent: 'codex' } as Partial<CanvasNode>), 'working')).toBe('Fix the login, Codex, Working')
  })

  test('no status words for a window with none, or none known yet', () => {
    const note = { id: 'n', kind: 'sticky', title: 'Plan', text: '', x: 0, y: 0, width: 200, height: 100, parentId: null, projectId: 'p1' } as CanvasNode
    expect(nodeAriaLabel(note, null)).toBe('Plan, Note')
    expect(nodeAriaLabel(claude(), 'unknown')).toBe('Fix the login, Claude Code')
    expect(nodeAriaLabel(claude({ title: '  ' }), 'idle')).toBe('Untitled, Claude Code, Idle')
  })

  test('every kind has words', () => {
    for (const kind of ['terminal', 'claude', 'run', 'sticky', 'whiteboard', 'group', 'browser', 'trigger', 'reader', 'file'] as const) {
      expect(kindName({ kind } as CanvasNode)).toMatch(/^[A-Z]/)
    }
  })

  test('the canvas hands the name to React Flow, which puts it on the node', () => {
    const doc = { version: 2, projects: [{ id: 'p1', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p1', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [claude()], edges: [], closed: [] } as unknown as CanvasDoc
    expect(toFlow(doc, { c: 'needs-you' }).nodes[0].ariaLabel).toBe('Fix the login, Claude Code, Needs you')
  })
})

describe('#6 F6 moves between the parts of the app', () => {
  // No small form open: the four parts of the app.
  const all = REGION_ORDER.filter((r) => r !== 'form')

  test('round the regions in order, and back with Shift+F6', () => {
    expect(nextStop({ region: 'menubar', inWindow: false }, all, 1)).toBe('sidebar')
    expect(nextStop({ region: 'sidebar', inWindow: false }, all, 1)).toBe('canvas')
    expect(nextStop({ region: 'canvas', inWindow: false }, all, 1)).toBe('dock')
    expect(nextStop({ region: 'dock', inWindow: false }, all, 1)).toBe('menubar')
    expect(nextStop({ region: 'menubar', inWindow: false }, all, -1)).toBe('dock')
  })

  test('a region that is not there is skipped, as the sidebar when it is closed', () => {
    expect(nextStop({ region: 'menubar', inWindow: false }, ['menubar', 'canvas', 'dock'], 1)).toBe('canvas')
  })

  test('from inside a window, a terminal included, the first press steps out to its frame', () => {
    expect(nextStop({ region: 'canvas', inWindow: true }, all, 1)).toBe('frame')
    expect(nextStop({ region: 'canvas', inWindow: true }, all, -1)).toBe('frame')
  })

  test('from the page itself, the first region, or the last going back', () => {
    expect(nextStop({ region: null, inWindow: false }, all, 1)).toBe('menubar')
    expect(nextStop({ region: null, inWindow: false }, all, -1)).toBe('dock')
    expect(nextStop({ region: null, inWindow: false }, [], 1)).toBeNull()
  })

  test('an open small form is one more stop, after the dock, both ways (a non-modal dialog)', () => {
    const withForm = [...REGION_ORDER]
    expect(nextStop({ region: 'dock', inWindow: false }, withForm, 1)).toBe('form')
    expect(nextStop({ region: 'form', inWindow: false }, withForm, 1)).toBe('menubar')
    expect(nextStop({ region: 'form', inWindow: false }, withForm, -1)).toBe('dock')
    expect(nextStop({ region: 'menubar', inWindow: false }, withForm, -1)).toBe('form')
    // Out of a terminal behind the form, the first press still goes to that window's frame.
    expect(nextStop({ region: 'canvas', inWindow: true }, withForm, 1)).toBe('frame')
  })

  test('a form says how to submit, close and leave it, following a rebound F6', () => {
    expect(helpWords('F6', 'Ctrl+K').form).toBe('Ctrl+Enter submits. Esc closes. F6 moves between this form and the rest of the app.')
    expect(helpWords('Alt+F6', null).form).toContain('Alt+F6 moves between this form')
    expect(helpWords(null, null).form).toBe('Ctrl+Enter submits. Esc closes.')
  })

  test('F6 is taken from a focused terminal, which has no other way out', () => {
    const next = ACTIONS.find((a) => a.id === 'next-region')!
    expect(actionForKey('F6', ACTIONS, {})).toBe(next)
    expect(actionForKey('Shift+F6', ACTIONS, {})?.id).toBe('prev-region')
    expect(appTakesKey('F6', 'terminal', isOverTerminal(next, {}), next.canvasOnly)).toBe(true)
    // It works over the board too: it's an App action.
    expect(actionReady(next, state({ board: true }))).toBe(true)
  })
})

describe('#7 small forms keep the keyboard and close on Esc', () => {
  test('Tab wraps in forms, modals and views, not in drawers you work beside', () => {
    expect(trapsTab('form')).toBe(true)
    expect(trapsTab('modal')).toBe(true)
    expect(trapsTab('view')).toBe(true)
    expect(trapsTab('drawer')).toBe(false)
  })

  test('an Esc from the canvas or the page closes an open form', () => {
    expect(windowEscCloses('form', { textEntry: false, ownsEsc: false })).toBe(true)
  })

  test('but not an Esc in a terminal or text box, which means something there', () => {
    expect(windowEscCloses('form', { textEntry: true, ownsEsc: false })).toBe(false)
    // Other panels keep their rule (panelKeyAction decides text boxes for drawers and views).
    expect(windowEscCloses('modal', { textEntry: true, ownsEsc: false })).toBe(true)
  })
})

describe('#8 what is announced', () => {
  const stop = (over: Partial<AgentStop> = {}): AgentStop => ({ kind: 'usage-limit', at: 1000, until: null, message: null, holds: 'reset', ...over })

  test('a permission names the tool', () => {
    expect(alertOf({ title: 'Fix the login', status: 'needs-you', approval: { requestId: 'r1', tool: 'Bash' } }, 0)).toEqual({ key: 'ask:r1', text: 'Fix the login needs you: Bash permission' })
  })

  test('needs you, setup failed, a stop, a start error and a failed run each have words', () => {
    expect(alertOf({ title: 'A', status: 'needs-you' }, 0)?.text).toBe('A needs you')
    expect(alertOf({ title: 'A', status: 'queued', setup: 'failed' }, 0)?.text).toBe('A: setup failed')
    expect(alertOf({ title: 'A', status: 'unknown', stop: stop({ kind: 'auth', holds: 'person' }) }, 0)?.text).toMatch(/^A stopped: /)
    expect(alertOf({ title: 'A', status: 'exited', error: 'Folder not found: C:\\gone' }, 0)?.text).toBe('A failed: Folder not found: C:\\gone')
    expect(alertOf({ title: 'Build', status: null, run: { running: false, exitCode: 2, stoppedByYou: false, at: 5 } }, 0)?.text).toBe('Build failed: Exited 2')
  })

  test('nothing to say while it works, rests, or ends normally', () => {
    for (const status of ['working', 'idle', 'starting', 'exited'] as const) expect(alertOf({ title: 'A', status }, 0)).toBeNull()
    expect(alertOf({ title: 'Build', status: null, run: { running: false, exitCode: 0, stoppedByYou: false, at: 5 } }, 0)).toBeNull()
    expect(alertOf({ title: 'Build', status: null, run: { running: false, exitCode: 1, stoppedByYou: true, at: 5 } }, 0)).toBeNull()
  })

  test('only the move into a state is said, once', () => {
    const a = (key: string, text: string): Alert => ({ key, text })
    const before = new Map([['x', a('needs', 'X needs you')]])
    expect(newAlerts(before, new Map(before))).toEqual([])
    expect(newAlerts(new Map(), before)).toEqual([{ id: 'x', key: 'needs', text: 'X needs you' }])
    // A new permission on a window already needing you is news.
    expect(newAlerts(before, new Map([['x', a('ask:2', 'X needs you: Bash permission')]])).map((n) => n.text)).toEqual(['X needs you: Bash permission'])
    // Gone back to work: nothing said.
    expect(newAlerts(before, new Map())).toEqual([])
  })

  const news = (id: string, key: string, text: string) => ({ id, key, text })

  test('throttled: what comes together is said together, and not again too soon', () => {
    const q = new AnnounceQueue()
    q.push([news('a', 'needs', 'A needs you'), news('b', 'run:1', 'B failed: Exited 1')], 0)
    expect(q.take(0)).toBe('A needs you. B failed: Exited 1.')
    q.push([news('c', 'needs', 'C needs you')], 100)
    expect(q.take(100)).toBeNull()
    expect(q.dueAt()).toBe(GAP_MS)
    expect(q.take(GAP_MS)).toBe('C needs you.')
  })

  test('deduplicated: the same alert on the same window is not said twice within a while', () => {
    const q = new AnnounceQueue()
    q.push([news('a', 'needs', 'A needs you')], 0)
    q.take(0)
    // Flapping back to needs you a moment later.
    q.push([news('a', 'needs', 'A needs you')], 2000)
    expect(q.take(2000)).toBeNull()
    q.push([news('a', 'needs', 'A needs you')], REPEAT_MS + 1)
    expect(q.take(REPEAT_MS + 1)).toBe('A needs you.')
  })

  test('review M2: a second permission with the same words, 3 s later, is said too', () => {
    const q = new AnnounceQueue()
    q.push([news('a', 'ask:r1', 'Fix the login needs you: Bash permission')], 0)
    expect(q.take(0)).toBe('Fix the login needs you: Bash permission.')
    q.push([news('a', 'ask:r2', 'Fix the login needs you: Bash permission')], 3000)
    expect(q.take(3000)).toBe('Fix the login needs you: Bash permission.')
  })

  test('the same words about two windows are both said', () => {
    const q = new AnnounceQueue()
    q.push([news('a', 'needs', 'Agent needs you')], 0)
    q.take(0)
    q.push([news('b', 'needs', 'Agent needs you')], 2000)
    expect(q.take(2000)).toBe('Agent needs you.')
  })

  test('a burst is said as a count past three', () => {
    expect(joinAlerts(['A needs you', 'B needs you', 'C needs you', 'D needs you', 'E needs you'])).toBe('A needs you. B needs you. C needs you. And 2 more.')
  })
})

describe('#9 tooltips teach the keys', () => {
  test('the bound key follows the label, and follows rebinding', () => {
    expect(withKey('Fit view', 'fit-view', {})).toBe('Fit view (Ctrl+Shift+F)')
    expect(withKey('Fit view', 'fit-view', { 'fit-view': 'Alt+F' })).toBe('Fit view (Alt+F)')
    expect(withKey('Fit view', 'fit-view', { 'fit-view': null })).toBe('Fit view')
    expect(withKey('Tidy canvas', 'tidy', {})).toBe('Tidy canvas')
    expect(withKey('Map', 'no-such-action', {})).toBe('Map')
  })

  test('the empty canvas hint has its two keys', () => {
    expect(keyOf('open-palette', {})).toBe('Ctrl+K')
    expect(keyOf('new-claude', {})).toBe('Ctrl+Shift+C')
  })
})

describe('review H1: window actions follow the keyboard, not the terminal typed in last', () => {
  test('the window the keyboard is on wins over a selection', () => {
    expect(windowFor({ frame: { id: 'b', session: true } }, null, 'c')).toBe('b')
    expect(windowFor({ terminal: 'a' }, null, 'c')).toBe('a')
  })

  test('on a note or a board frame there is no window, even with a session selected', () => {
    expect(windowFor({ frame: { id: 'note', session: false } }, null, 'c')).toBeNull()
  })

  test('with the keyboard nowhere, only a single selected session counts', () => {
    expect(windowFor({}, null, 'c')).toBe('c')
    expect(windowFor({}, null, null)).toBeNull()
  })

  test('a maximized window is always the one', () => {
    expect(windowFor({ frame: { id: 'b', session: true } }, 'm', 'c')).toBe('m')
  })
})

describe('#10 the palette acts on the window in use', () => {
  const ready = (id: string, s: MenuState): boolean => actionReady(ACTIONS.find((a) => a.id === id)!, s)

  test('rename, restart and close are there for a window', () => {
    expect(ready('rename-window', state())).toBe(false)
    expect(ready('rename-window', state({ hasWindow: true }))).toBe(true)
    expect(ready('close-window', state({ hasWindow: true }))).toBe(true)
    // Restart only for one that has ended or failed, as the menu offers it.
    expect(ready('restart-window', state({ hasWindow: true }))).toBe(false)
    expect(ready('restart-window', state({ hasWindow: true, canRestart: true }))).toBe(true)
  })

  test('they run the window commands', () => {
    const c = new Proxy({} as Commands, { get: (t, k) => ((t as unknown as Record<string, unknown>)[k as string] ??= vi.fn()) })
    for (const id of ['rename-window', 'restart-window', 'close-window']) ACTIONS.find((a) => a.id === id)!.run(c)
    expect(c.renameWindow).toHaveBeenCalled()
    expect(c.restartWindow).toHaveBeenCalled()
    expect(c.closeWindow).toHaveBeenCalled()
  })

  test('F2 renames on the canvas, and is left to a terminal or a text box', () => {
    const rename = ACTIONS.find((a) => a.id === 'rename-window')!
    expect(actionForKey('F2', ACTIONS, {})).toBe(rename)
    expect(appTakesKey('F2', 'canvas', isOverTerminal(rename, {}), rename.canvasOnly)).toBe(true)
    expect(appTakesKey('F2', 'terminal', isOverTerminal(rename, {}), rename.canvasOnly)).toBe(false)
    expect(appTakesKey('F2', 'text', isOverTerminal(rename, {}), rename.canvasOnly)).toBe(false)
    // A key someone chose themselves goes wherever the keyboard is, as for any other action.
    expect(appTakesKey('Alt+R', 'terminal', isOverTerminal(rename, { 'rename-window': 'Alt+R' }), rename.canvasOnly)).toBe(true)
  })

  test('closing a busy window asks first, as its close button does', () => {
    expect(closeQuestion('working')).toBe('Still working. Close anyway?')
    expect(closeQuestion('needs-you')).toBe('Waiting on you. Close anyway?')
    expect(closeQuestion('idle')).toBeUndefined()
    expect(closeQuestion(undefined)).toBeUndefined()
  })
})
