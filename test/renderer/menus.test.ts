import { describe, expect, test, vi } from 'vitest'
import { ACTIONS } from '../../src/renderer/actions'
import {
  canvasExtensions,
  canvasMenu,
  clampToViewport,
  closedProjectMenu,
  deleteProjectWarning,
  editMenu,
  fileMenu,
  nodeMenu,
  projectMenu,
  helpMenu,
  viewMenu,
  type Commands,
  type MenuEntry,
  type MenuItem,
  type MenuState
} from '../../src/renderer/menus'
import { sessionTree } from '../../src/renderer/sessionTree'
import { takeSettingsSection } from '../../src/renderer/settingsAsk'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { triggerNode } from '../trigger/fixtures'

const commands = new Proxy({} as Commands, { get: () => vi.fn() })
const state: MenuState = { selectedCount: 0, canCopy: false, canFind: false, sidebar: true, minimap: true, legend: false, snap: false, canUndo: false, canRedo: false, hasWindow: false, canName: false, canCloseProject: true }
const box = { title: 'T', x: 0, y: 0, width: 100, height: 100, parentId: null }
const terminal: CanvasNode = { ...box, id: 't', kind: 'terminal', cwd: 'C:\\a' }
const claude: CanvasNode = { ...box, id: 'c', kind: 'claude', cwd: 'C:\\b', sessionId: null, transcriptPath: null, after: [] }
const sticky: CanvasNode = { ...box, id: 's', kind: 'sticky', text: '' }
const group: CanvasNode = { ...box, id: 'g', kind: 'group', worktree: null }

const items = (menu: MenuEntry[]): MenuItem[] => menu.filter((e): e is MenuItem => e !== 'separator')
const find = (menu: MenuEntry[], id: string): MenuItem | undefined => items(menu).find((i) => i.id === id)

describe('menu bar', () => {
  test('File, Edit, View and Help each have working items', () => {
    for (const menu of [fileMenu(commands, state), editMenu(commands, state), viewMenu(commands, state), helpMenu(commands)]) {
      expect(items(menu).length).toBeGreaterThan(0)
      for (const item of items(menu)) expect(typeof item.run).toBe('function')
    }
  })

  test('Group names itself after the selection', () => {
    expect(find(fileMenu(commands, state), 'group')?.label).toBe('New group')
    expect(find(fileMenu(commands, { ...state, selectedCount: 2 }), 'group')?.label).toBe('Group selection')
  })

  test('The same thing has the same name in every menu', () => {
    const tab = projectMenu(commands, 'p', { sessionTitles: [], items: 0, canClose: true, last: false, rename: () => {} })
    expect(find(tab, 'manage-projects')?.label).toBe('Projects…')
    expect(find(fileMenu(commands, state), 'manage-projects')?.label).toBe('Projects…')
    // Projects… lives in File only.
    expect(find(viewMenu(commands, state), 'manage-projects')).toBeUndefined()
    expect(find(editMenu(commands, state), 'select-all')?.label).toBe(find(canvasMenu(commands, state, { x: 0, y: 0 }), 'select-all')?.label)
    expect(find(canvasMenu(commands, state, { x: 0, y: 0 }), 'spawn-team')?.label).toBe('New team…')
    expect(ACTIONS.find((a) => a.id === 'spawn-team')?.label).toBe('New team…')
    expect(ACTIONS.find((a) => a.id === 'manage-projects')?.label).toBe('Projects…')
  })

  test('Close selected is off with nothing selected', () => {
    expect(find(fileMenu(commands, state), 'close-selected')?.disabled).toBe(true)
    expect(find(fileMenu(commands, { ...state, selectedCount: 1 }), 'close-selected')?.disabled).toBe(false)
  })

  test('Edit follows what the focused terminal can do', () => {
    expect(find(editMenu(commands, state), 'copy')?.disabled).toBe(true)
    expect(find(editMenu(commands, state), 'find')?.disabled).toBe(true)
    const ready = editMenu(commands, { ...state, canCopy: true, canFind: true })
    expect(find(ready, 'copy')?.disabled).toBe(false)
    expect(find(ready, 'find')?.disabled).toBe(false)
  })

  test('View toggles show their state', () => {
    expect(find(viewMenu(commands, state), 'toggle-sidebar')?.checked).toBe(true)
    expect(find(viewMenu(commands, state), 'toggle-legend')?.checked).toBe(false)
    expect(find(viewMenu(commands, { ...state, snap: true }), 'toggle-snap')?.checked).toBe(true)
  })

  // A top-level Settings menu held only Settings… and Snap to grid, and there was no menu way to the shortcuts, the log
  // or About (docs/ux-review-settings.md, S22).
  test('Help opens Settings at the shortcuts or About, and Settings… itself is under File', () => {
    const openSettings = vi.fn()
    const c = { ...({} as Commands), openSettings }
    find(helpMenu(c), 'help-shortcuts')!.run()
    expect(takeSettingsSection()).toBe('keys')
    find(helpMenu(c), 'help-about')!.run()
    expect(takeSettingsSection()).toBe('about')
    expect(openSettings).toHaveBeenCalledTimes(2)
    expect(items(helpMenu(c)).map((i) => i.id)).toEqual(['help-shortcuts', 'help-log', 'open-log-folder', 'copy-diagnostics', 'help-about'])
    expect(find(fileMenu(commands, state), 'open-settings')).toBeTruthy()
  })
})

describe('right-click menus', () => {
  test('the canvas opens nodes where you clicked', () => {
    const newTerminal = vi.fn()
    const c = { ...commands, newTerminal } as Commands
    const at = { x: 10, y: 20 }
    find(canvasMenu(c, state, at), 'new-terminal')?.run()
    expect(newTerminal).toHaveBeenCalledWith(at)
  })

  test('a busy session asks before closing, an idle one does not', () => {
    expect(find(nodeMenu(commands, terminal, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }), 'close')?.confirm).toBeUndefined()
    const idle = nodeMenu(commands, claude, 'idle', { at: { x: 0, y: 0 }, canCopy: false, canRestart: false })
    expect(find(idle, 'close')?.confirm).toBeUndefined()
    for (const status of ['working', 'needs-you'] as const) {
      const menu = nodeMenu(commands, claude, status, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false })
      expect(find(menu, 'close')?.confirm).toBeTruthy()
    }
  })

  test('Restart appears only when a session can restart', () => {
    expect(find(nodeMenu(commands, claude, 'idle', { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }), 'restart')).toBeUndefined()
    expect(find(nodeMenu(commands, claude, 'exited', { at: { x: 0, y: 0 }, canCopy: false, canRestart: true }), 'restart')).toBeDefined()
  })

  test('each kind of node gets its own menu', () => {
    const ctx = { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }
    expect(find(nodeMenu(commands, terminal, null, ctx), 'paste')).toBeDefined()
    expect(find(nodeMenu(commands, sticky, null, ctx), 'paste')).toBeUndefined()
    expect(find(nodeMenu(commands, sticky, null, ctx), 'close')?.label).toBe('Delete note')
    expect(find(nodeMenu(commands, group, null, ctx), 'close')?.label).toBe('Remove group')
    expect(find(nodeMenu(commands, group, null, ctx), 'new-terminal')).toBeDefined()
  })

  test('new sessions from a group menu open in that group', () => {
    const newTerminal = vi.fn()
    const c = { ...commands, newTerminal } as Commands
    const at = { x: 1, y: 2 }
    find(nodeMenu(c, group, null, { at, canCopy: false, canRestart: false }), 'new-terminal')?.run()
    expect(newTerminal).toHaveBeenCalledWith(at, 'g')
  })
})

describe('icons and shared ids', () => {
  const at = { x: 0, y: 0 }

  test('every option in the canvas menu has an icon', () => {
    for (const item of items(canvasMenu(commands, state, at))) expect(item.icon, item.id).toBeTruthy()
  })

  test('every option in the menu bar menus has an icon', () => {
    for (const menu of [fileMenu(commands, state), editMenu(commands, state), viewMenu(commands, state), helpMenu(commands)]) {
      for (const item of items(menu)) expect(item.icon, item.id).toBeTruthy()
    }
  })

  test('the canvas menu is split into sections with no stray separators', () => {
    const menu = canvasMenu(commands, state, at)
    expect(menu.filter((e) => e === 'separator').length).toBeGreaterThanOrEqual(3)
    expect(menu[0]).not.toBe('separator')
    expect(menu[menu.length - 1]).not.toBe('separator')
    expect(menu.some((e, i) => e === 'separator' && menu[i + 1] === 'separator')).toBe(false)
  })

  test('Spawn a team is in the canvas and File menus, and opens where you clicked', () => {
    const spawnTeamForm = vi.fn()
    const c = { ...commands, spawnTeamForm } as Commands
    find(canvasMenu(c, state, { x: 3, y: 4 }), 'spawn-team')?.run()
    expect(spawnTeamForm).toHaveBeenCalledWith({ x: 3, y: 4 })
    expect(find(fileMenu(commands, state), 'spawn-team')).toBeDefined()
  })

  test('New trigger is in the canvas menu, with an icon, and in the File menu and the palette', () => {
    const newTriggerForm = vi.fn()
    const c = { ...commands, newTriggerForm } as Commands
    expect(canvasExtensions(c, at).map((i) => [i.id, i.icon])).toEqual([['new-trigger', 'trigger'], ['new-from-recipe', 'team'], ['try-approach', 'branch'], ['open-document', 'note']])
    find(canvasMenu(c, state, at), 'new-trigger')?.run()
    expect(newTriggerForm).toHaveBeenCalledWith(at)
    expect(find(fileMenu(commands, state), 'new-trigger')).toBeDefined()
    expect(ACTIONS.some((a) => a.id === 'new-trigger' && a.icon === 'trigger')).toBe(true)
  })

  test('New run configuration is beside New run command everywhere', () => {
    expect(find(canvasMenu(commands, state, at), 'new-run-config')?.icon).toBe('launch')
    expect(find(fileMenu(commands, state), 'new-run-config')).toBeDefined()
    expect(ACTIONS.some((a) => a.id === 'new-run-config')).toBe(true)
  })

  test('a trigger offers Arm only while disarmed, and Run now only while armed', () => {
    const t = triggerNode('tr')
    const menu = nodeMenu(commands, t, null, { at, canCopy: false, canRestart: false })
    expect(find(menu, 'arm-trigger')).toBeDefined()
    expect(find(menu, 'run-trigger')?.disabled).toBe(true)
    const armed = nodeMenu(commands, { ...t, armedSpec: canonicalSpec(t) }, null, { at, canCopy: false, canRestart: false })
    expect(find(armed, 'disarm-trigger')).toBeDefined()
    expect(find(armed, 'run-trigger')?.disabled).toBe(false)
  })

  test('a launch.json run node has no free-form command to edit', () => {
    const run = { id: 'r', kind: 'run' as const, title: 'r', cwd: 'C:\\x', command: 'x', launch: { folder: 'C:\\x', name: 'App' }, x: 0, y: 0, width: 1, height: 1, parentId: null }
    expect(find(nodeMenu(commands, run, null, { at, canCopy: false, canRestart: false }), 'edit-command')).toBeUndefined()
  })

  test('the View menu opens the palette', () => {
    const openPalette = vi.fn()
    const c = { ...commands, openPalette } as Commands
    find(viewMenu(c, state), 'open-palette')?.run()
    expect(openPalette).toHaveBeenCalled()
  })

  test('Undo and Redo follow what can be done, and say what', () => {
    expect(find(editMenu(commands, state), 'undo')?.disabled).toBe(true)
    const ready = editMenu(commands, { ...state, canUndo: true, undoLabel: 'move' })
    expect(find(ready, 'undo')?.disabled).toBe(false)
    expect(find(ready, 'undo')?.label).toBe('Undo move')
  })

  test('menu items that the registry has keep the same ids, so their shortcuts are right', () => {
    const registered = new Set(ACTIONS.map((a) => a.id))
    for (const id of ['new-terminal', 'new-claude', 'spawn-team', 'group', 'select-all', 'fit-view', 'tidy', 'recent', 'undo', 'redo', 'copy', 'paste', 'find', 'open-palette', 'open-settings', 'toggle-sidebar', 'zoom-in']) {
      expect(registered.has(id), id).toBe(true)
    }
  })
})

describe('project menus', () => {
  const ctx = { sessionTitles: ['Dev', 'Claude'], items: 2, canClose: true, last: false, rename: () => {} }

  test('closing only hides, so it asks nothing', () => {
    const closeProject = vi.fn()
    const item = find(projectMenu({ ...commands, closeProject } as Commands, 'a', ctx), 'close-project')!
    expect(item.confirm).toBeUndefined()
    expect(item.danger).toBeFalsy()
    item.run()
    expect(closeProject).toHaveBeenCalledWith('a')
  })

  test('with no other project open it cannot close', () => {
    expect(find(projectMenu(commands, 'a', { ...ctx, canClose: false }), 'close-project')?.disabled).toBe(true)
  })

  test('deleting always asks, and names what it ends', () => {
    const item = find(projectMenu(commands, 'a', ctx), 'delete-project')!
    expect(item.danger).toBe(true)
    expect(item.confirm).toContain('"Dev"')
    expect(item.confirm).toContain('"Claude"')
    expect(item.confirm).toContain('2 notes and groups')
    expect(item.confirm).toMatch(/for good/)
    expect(find(projectMenu(commands, 'a', { ...ctx, sessionTitles: [], items: 0 }), 'delete-project')?.confirm).toMatch(/for good/)
  })

  test('the warning shortens a long list but keeps the count', () => {
    expect(deleteProjectWarning(['a', 'b', 'c', 'd', 'e'], 0)).toBe('Ends "a", "b", "c" and 2 more. Delete this project for good?')
    expect(deleteProjectWarning(['a'], 1)).toBe('Ends "a". Removes 1 note or group. Delete this project for good?')
    expect(deleteProjectWarning(['a', 'b'], 0)).toBe('Ends "a" and "b". Delete this project for good?')
  })

  test('the last project cannot be deleted', () => {
    expect(find(projectMenu(commands, 'a', { ...ctx, last: true }), 'delete-project')?.disabled).toBe(true)
  })

  test('a closed project reopens or deletes', () => {
    const reopenProject = vi.fn()
    const menu = closedProjectMenu({ ...commands, reopenProject } as Commands, 'a', { sessionTitles: ['Dev'], items: 0 })
    find(menu, 'reopen-project')?.run()
    expect(reopenProject).toHaveBeenCalledWith('a')
    expect(find(menu, 'delete-project')?.confirm).toContain('"Dev"')
  })

  test('the File menu offers closed projects back', () => {
    const reopenProject = vi.fn()
    const menu = fileMenu({ ...commands, reopenProject } as Commands, { ...state, closedProjects: [{ id: 'b', name: 'Site' }] })
    const item = find(menu, 'reopen-project-b')!
    expect(item.label).toContain('Site')
    item.run()
    expect(reopenProject).toHaveBeenCalledWith('b')
  })
})

describe('clampToViewport', () => {
  test('leaves a menu that fits where it is', () => {
    expect(clampToViewport({ x: 100, y: 100 }, { width: 200, height: 300 }, { width: 1000, height: 800 })).toEqual({ x: 100, y: 100 })
  })

  test('pulls a menu back inside at the right and bottom edges', () => {
    expect(clampToViewport({ x: 950, y: 750 }, { width: 200, height: 300 }, { width: 1000, height: 800 })).toEqual({ x: 792, y: 492 })
  })

  test('a menu taller than the window is placed at the height it scrolls at, from the top margin', () => {
    expect(clampToViewport({ x: 100, y: 300 }, { width: 200, height: 900 }, { width: 1000, height: 600 })).toEqual({ x: 100, y: 8 })
  })

  test('never goes past the top left, even in a tiny window', () => {
    expect(clampToViewport({ x: 50, y: 50 }, { width: 500, height: 500 }, { width: 300, height: 300 })).toEqual({ x: 8, y: 8 })
  })
})

describe('sessionTree', () => {
  const doc: CanvasDoc = {
    version: 3, projects: [], activeProjectId: '',
    viewport: { x: 0, y: 0, zoom: 1 },
    edges: [],
    closed: [],
    nodes: [
      { ...group, title: 'Team' },
      { ...terminal, id: 'in', title: 'Inside', parentId: 'g' },
      { ...claude, id: 'out', title: 'Outside', cwd: 'C:\\repo' },
      sticky
    ]
  }

  test('lists sessions by group and leaves out notes', () => {
    const tree = sessionTree(doc, '')
    expect(tree.groups.map((g) => [g.group.title, g.sessions.map((s) => s.id)])).toEqual([['Team', ['in']]])
    expect(tree.ungrouped.map((s) => s.id)).toEqual(['out'])
    expect(tree.total).toBe(2)
  })

  test('filters by title or folder, ignoring case, and drops empty groups', () => {
    expect(sessionTree(doc, 'INSIDE').groups[0].sessions[0].id).toBe('in')
    const byFolder = sessionTree(doc, 'repo')
    expect(byFolder.ungrouped.map((s) => s.id)).toEqual(['out'])
    expect(byFolder.groups).toEqual([])
    expect(byFolder.total).toBe(2)
  })
})

// F6: an error, a URL or a summary in a terminal is kept on the canvas instead of scrolling away (src/renderer/pinOutput.ts).
test('a session window offers Pin selection to a note right after Copy, only with something selected', () => {
  const ids = (canCopy: boolean) => items(nodeMenu(commands, terminal, null, { at: { x: 0, y: 0 }, canCopy, canRestart: false }))
  const withSelection = ids(true)
  const copyAt = withSelection.findIndex((i) => i.id === 'copy')
  expect(withSelection[copyAt + 1]).toMatchObject({ id: 'pin-selection', label: 'Pin selection to a note', disabled: false })
  expect(ids(false).find((i) => i.id === 'pin-selection')?.disabled).toBe(true)
})

// F22: an agent's latest answer, as Markdown, without scrolling and selecting (src/main/lastReply.ts).
test('an agent window offers Copy last reply once it has a conversation; a terminal does not', () => {
  const menu = (node: CanvasNode) => items(nodeMenu(commands, node, 'idle', { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }))
  expect(menu({ ...claude, transcriptPath: 'C:\t.jsonl' } as CanvasNode).find((i) => i.id === 'copy-last-reply')).toMatchObject({ label: 'Copy last reply', disabled: false })
  expect(menu({ ...claude, transcriptPath: null } as CanvasNode).find((i) => i.id === 'copy-last-reply')?.disabled).toBe(true)
  expect(menu(terminal).find((i) => i.id === 'copy-last-reply')).toBeUndefined()
})

// F28: the whole conversation kept as Markdown, and the raw transcript found, from the agent's menu (src/main/conversation.ts).
test('an agent window offers Save conversation and Reveal transcript right after Copy last reply, once it has a conversation', () => {
  const menu = (node: CanvasNode) => items(nodeMenu(commands, node, 'idle', { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }))
  const withOne = menu({ ...claude, transcriptPath: 'C:\\t.jsonl' } as CanvasNode)
  const copyAt = withOne.findIndex((i) => i.id === 'copy-last-reply')
  expect(withOne[copyAt + 1]).toMatchObject({ id: 'save-conversation', label: 'Save conversation…', disabled: false })
  expect(withOne[copyAt + 2]).toMatchObject({ id: 'reveal-transcript', label: 'Reveal transcript', disabled: false })
  const without = menu({ ...claude, transcriptPath: null } as CanvasNode)
  expect(without.find((i) => i.id === 'save-conversation')?.disabled).toBe(true)
  expect(without.find((i) => i.id === 'reveal-transcript')?.disabled).toBe(true)
  expect(menu(terminal).find((i) => i.id === 'save-conversation' || i.id === 'reveal-transcript')).toBeUndefined()
})

// F31: a failed run's command and output go to a new agent from its menu (src/renderer/runFixUi.ts).
test('a run window offers Ask an agent to fix only once it has failed', () => {
  const run = { id: 'r', kind: 'run' as const, title: 'npm test', cwd: 'C:\\x', command: 'npm test', x: 0, y: 0, width: 1, height: 1, parentId: null }
  const menu = (runFailed?: boolean) => items(nodeMenu(commands, run, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false, runFailed }))
  expect(menu(true).find((i) => i.id === 'ask-to-fix')).toMatchObject({ label: 'Ask an agent to fix…' })
  expect(menu(false).find((i) => i.id === 'ask-to-fix')).toBeUndefined()
  expect(menu().find((i) => i.id === 'ask-to-fix')).toBeUndefined()
  expect(items(nodeMenu(commands, claude, 'idle', { at: { x: 0, y: 0 }, canCopy: false, canRestart: false, runFailed: true })).find((i) => i.id === 'ask-to-fix')).toBeUndefined()
})

// F26: one window's notifications can be turned off from its menu.
test('an agent or run window offers Mute notifications, and Unmute once muted; a terminal, which never notifies, does not', () => {
  const menu = (node: CanvasNode) => items(nodeMenu(commands, node, 'idle', { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }))
  expect(menu(claude).find((i) => i.id === 'toggle-mute')?.label).toBe('Mute notifications')
  expect(menu({ ...claude, muted: true } as CanvasNode).find((i) => i.id === 'toggle-mute')?.label).toBe('Unmute notifications')
  expect(menu(terminal).find((i) => i.id === 'toggle-mute')).toBeUndefined()
})

// F32: an error in a terminal goes to the agent linked to it in one step, without a note left behind.
test('with something selected, a window linked to agents offers Send selection to each, right after Pin selection', () => {
  const sent: string[] = []
  const own = new Proxy({} as Commands, { get: (_t, key) => (key === 'sendSelection' ? (from: string, to: string) => sent.push(`${from}>${to}`) : vi.fn()) })
  const menu = (canCopy: boolean, agents: Array<{ id: string; title: string }>) => items(nodeMenu(own, terminal, null, { at: { x: 0, y: 0 }, canCopy, canRestart: false, agents }))
  const one = menu(true, [{ id: 'a1', title: 'Fixer' }])
  const pinAt = one.findIndex((i) => i.id === 'pin-selection')
  expect(one[pinAt + 1]).toMatchObject({ id: 'send-selection', label: 'Send selection to Fixer', disabled: false })
  one[pinAt + 1].run()
  expect(sent).toEqual(['t>a1'])
  const two = menu(true, [{ id: 'a1', title: 'Fixer' }, { id: 'a2', title: 'Reviewer' }]).find((i) => i.id === 'send-selection')!
  expect(two.label).toBe('Send selection to')
  const rows = items(two.submenu!)
  expect(rows.map((r) => r.label)).toEqual(['Fixer', 'Reviewer'])
  rows[1].run()
  expect(sent).toEqual(['t>a1', 't>a2'])
  expect(menu(false, [{ id: 'a1', title: 'Fixer' }]).find((i) => i.id === 'send-selection')?.disabled).toBe(true)
  expect(menu(true, []).find((i) => i.id === 'send-selection')).toBeUndefined()
})

// F30: one message to a whole team, rather than typed into each window.
test('with two or more agents selected, the canvas menu offers Send to N agents', () => {
  const ids = (selectedAgents: number) => items(canvasMenu(commands, { ...state, selectedCount: selectedAgents, selectedAgents }, { x: 0, y: 0 }))
  expect(ids(3).find((i) => i.id === 'send-to-agents')?.label).toBe('Send to 3 agents…')
  expect(ids(1).find((i) => i.id === 'send-to-agents')).toBeUndefined()
  expect(items(canvasMenu(commands, state, { x: 0, y: 0 })).find((i) => i.id === 'send-to-agents')).toBeUndefined()
})

// F43: a build log or terminal session kept as a text file.
test('terminal and run windows offer Save output; an agent has Save conversation instead', () => {
  const menu = (node: CanvasNode) => items(nodeMenu(commands, node, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }))
  expect(menu(terminal).find((i) => i.id === 'save-output')?.label).toBe('Save output…')
  expect(menu({ ...terminal, id: 'r', kind: 'run', command: 'npm test' } as CanvasNode).find((i) => i.id === 'save-output')).toBeDefined()
  expect(menu(claude).find((i) => i.id === 'save-output')).toBeUndefined()
})
