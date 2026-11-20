import { isArmed } from '../core/trigger/arming'
import type { AgentStatus, CanvasNode } from '../shared/model'
import type { IconName } from './iconPaths'
import type { Direction } from './nodeNav'
import { openHandoff } from './searchUi'
import { openRecipePicker, openRecipeSave } from './recipeUi'
import { toggleReviewInbox } from './reviewInboxUi'
import { terminalProfileItems } from './terminalProfilesUi'
import { openComparisons, openTryApproach } from './compareUi'
import { askArchive, openProjects } from './projectsUi'
import { openDocumentEntry, openPlanEntry, readerMenu } from './reader/readerUi'
import { fileNodeMenu, toggleFileShelf } from './fileShelfUi'

export interface Point {
  x: number
  y: number
}

export interface MenuItem {
  id: string
  label: string
  run: () => void
  icon?: IconName
  /** For a key that isn't this item's id in the action registry. Menus look the rest up there. */
  shortcut?: string
  disabled?: boolean
  /** A toggle's current state. */
  checked?: boolean
  /** Asks before running, in the confirmation dialog: what happens, in a sentence. */
  confirm?: string
  danger?: boolean
}

export type MenuEntry = MenuItem | 'separator'

/** What menus can do. `at` is a screen position; with none, a new node opens in the middle of the view. */
export interface Commands {
  newProject(): void
  createProject(fields: { name: string; folder: string }): void
  switchProject(id: string): void
  setProjectName(id: string, name: string): void
  chooseProjectFolder(id: string): void
  /** Hides a project, leaving its sessions running. With no id, the one on screen. */
  closeProject(id?: string): void
  /** Brings a closed project back onto the tabs and the screen. */
  reopenProject(id: string): void
  /** Removes a project for good, ending its sessions. */
  deleteProject(id: string): void
  /** Moves a project's tab one place along the open tabs, undoably. With no id, the one on screen. */
  moveProjectTab(step: -1 | 1, id?: string): void
  /** Shows a session, switching to its project first if need be. */
  revealNode(id: string): void
  /** With a profile id, a terminal of that profile. Without, the default. */
  newTerminal(at?: Point, groupId?: string, profileId?: string): void
  newTerminalForm(at?: Point, groupId?: string): void
  newSshForm(at?: Point, groupId?: string): void
  newClaudeForm(at?: Point, groupId?: string): void
  newCodexForm(at?: Point, groupId?: string): void
  newRunForm(at?: Point, groupId?: string): void
  newBrowser(at?: Point, groupId?: string): void
  /** Stops agent verbs on a browser node, or lets them through again. */
  setBrowserHeld(id: string, held: boolean): void
  reloadBrowser(id: string): void
  spawnTeamForm(at?: Point): void
  /** Picks a configuration or compound from a folder's .vscode/launch.json. */
  newRunConfigForm(at?: Point, groupId?: string): void
  newTriggerForm(at?: Point): void
  editTrigger(id: string): void
  /** Shows exactly what arming agrees to, and arms only from there. */
  armTrigger(id: string): void
  disarmTrigger(id: string): void
  runTriggerNow(id: string): void
  editRunCommand(id: string): void
  newSticky(at?: Point): void
  newWhiteboard(at?: Point): void
  group(at?: Point): void
  closeSelected(): void
  closeNode(id: string): void
  renameNode(id: string): void
  restartNode(id: string): void
  toggleRecent(): void
  quit(): void
  stopAllAndQuit(): void
  copy(nodeId?: string): void
  paste(nodeId?: string): void
  find(nodeId?: string): void
  /** Rebuilds a window's terminal view. The session isn't touched. With no id, the window in use. */
  refreshWindow(nodeId?: string): void
  nameWithAi(nodeId?: string): void
  toggleMaximize(nodeId?: string): void
  stepFont(step: number, nodeId?: string): void
  resetFont(nodeId?: string): void
  moveFocus(direction: Direction): void
  undo(): void
  redo(): void
  selectAll(): void
  zoomIn(): void
  zoomOut(): void
  zoomReset(): void
  fitView(): void
  tidy(ids?: string[]): void
  togglePref(key: 'sidebar' | 'minimap' | 'legend' | 'snap'): void
  openSettings(): void
  openPalette(): void
  /** Shows or hides the git panel. With a folder, shows it on that folder's repository. */
  toggleGit(folder?: string): void
  /** Swaps the canvas for the project's board, or back. */
  toggleBoard(): void
  /** The focus view: windows in split panes, filling the app. With an id, that window joins it. */
  toggleFocus(nodeId?: string): void
}

export interface MenuState {
  selectedCount: number
  canCopy: boolean
  canFind: boolean
  sidebar: boolean
  minimap: boolean
  legend: boolean
  snap: boolean
  canUndo: boolean
  canRedo: boolean
  /** What undo and redo would do, for their menu labels. */
  undoLabel?: string
  redoLabel?: string
  /** There's a window for window actions to act on. */
  hasWindow: boolean
  /** That window can be named from its output. */
  canName: boolean
  /** There's another open project to show if this one closes. */
  canCloseProject: boolean
  closedProjects?: { id: string; name: string }[]
  gitPanel?: boolean
  board?: boolean
  focus?: boolean
}

export function addMenu(c: Commands, at?: Point): MenuEntry[] {
  return [
    { id: 'new-terminal', label: 'New terminal', icon: 'terminal', run: () => c.newTerminal(at) },
    ...terminalProfileItems((profile) => c.newTerminal(at, undefined, profile)),
    { id: 'new-terminal-form', label: 'New terminal in a folder…', icon: 'folder', run: () => c.newTerminalForm(at) },
    { id: 'new-ssh', label: 'SSH to host…', icon: 'server', run: () => c.newSshForm(at) },
    { id: 'new-claude', label: 'New Claude Code…', icon: 'claude', run: () => c.newClaudeForm(at) },
    { id: 'new-codex', label: 'New Codex…', icon: 'codex', run: () => c.newCodexForm(at) },
    { id: 'new-run', label: 'New run command…', icon: 'run', run: () => c.newRunForm(at) },
    { id: 'new-run-config', label: 'New run configuration…', icon: 'launch', run: () => c.newRunConfigForm(at) },
    { id: 'new-browser', label: 'New browser', icon: 'browser', run: () => c.newBrowser(at) },
    { id: 'spawn-team', label: 'New team…', icon: 'team', run: () => c.spawnTeamForm(at) },
    { id: 'new-trigger', label: 'New trigger…', icon: 'trigger', run: () => c.newTriggerForm(at) },
    { id: 'new-from-recipe', label: 'New from recipe…', icon: 'team', run: () => openRecipePicker(at) },
    { id: 'new-sticky', label: 'New note', icon: 'note', run: () => c.newSticky(at) },
    { id: 'new-whiteboard', label: 'New whiteboard', icon: 'whiteboard', run: () => c.newWhiteboard(at) }
  ]
}

function names(titles: string[]): string {
  const shown = titles.slice(0, 3).map((t) => `"${t}"`)
  const more = titles.length - shown.length
  if (more > 0) return `${shown.join(', ')} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] ?? '')
}

/** Says exactly what deleting a project ends, since that can't be taken back. */
export function deleteProjectWarning(sessionTitles: string[], items: number): string {
  const parts = [
    ...(sessionTitles.length ? [`Ends ${names(sessionTitles)}.`] : []),
    ...(items ? [`Removes ${items === 1 ? '1 note or group' : `${items} notes and groups`}.`] : [])
  ]
  return `${parts.join(' ')}${parts.length ? ' ' : ''}Delete this project for good?`
}

/** A project tab's right-click menu. Closing only hides a project. Deleting is the separate one, and always asks. */
export function projectMenu(
  c: Commands,
  id: string,
  ctx: { sessionTitles: string[]; items: number; canClose: boolean; last: boolean; rename: () => void; canMoveLeft?: boolean; canMoveRight?: boolean; archiveRefusal?: string | null }
): MenuEntry[] {
  return [
    { id: 'rename-project', label: 'Rename', icon: 'edit', run: ctx.rename },
    { id: 'project-folder', label: 'Choose folder…', icon: 'folder', run: () => c.chooseProjectFolder(id) },
    { id: 'move-project-left', label: 'Move left', icon: 'arrow-left', disabled: !ctx.canMoveLeft, run: () => c.moveProjectTab(-1, id) },
    { id: 'move-project-right', label: 'Move right', icon: 'arrow-right', disabled: !ctx.canMoveRight, run: () => c.moveProjectTab(1, id) },
    'separator',
    { id: 'close-project', label: 'Close project, leaving its sessions running', icon: 'folder-closed', disabled: !ctx.canClose, run: () => c.closeProject(id) },
    { id: 'archive-project', label: 'Archive project, stopping its sessions…', icon: 'archive', disabled: !!ctx.archiveRefusal, run: () => askArchive(id) },
    { id: 'manage-projects', label: 'Projects…', icon: 'project', run: () => openProjects() },
    { id: 'delete-project', label: 'Delete project…', icon: 'trash', danger: true, disabled: ctx.last, confirm: deleteProjectWarning(ctx.sessionTitles, ctx.items), run: () => c.deleteProject(id) }
  ]
}

/** A closed project's right-click menu, in the sidebar's list. */
export function closedProjectMenu(c: Commands, id: string, ctx: { sessionTitles: string[]; items: number }): MenuEntry[] {
  return [
    { id: 'reopen-project', label: 'Reopen', icon: 'folder-open', run: () => c.reopenProject(id) },
    { id: 'archive-project', label: 'Archive, stopping its sessions…', icon: 'archive', run: () => askArchive(id) },
    'separator',
    { id: 'delete-project', label: 'Delete project…', icon: 'trash', danger: true, confirm: deleteProjectWarning(ctx.sessionTitles, ctx.items), run: () => c.deleteProject(id) }
  ]
}

export function fileMenu(c: Commands, s: MenuState): MenuEntry[] {
  const closed = s.closedProjects ?? []
  return [
    { id: 'new-project', label: 'New project…', icon: 'project', run: c.newProject },
    { id: 'manage-projects', label: 'Projects…', icon: 'project', run: () => openProjects() },
    'separator',
    ...addMenu(c),
    { id: 'group', label: s.selectedCount ? 'Group selection' : 'New group', icon: 'group', run: () => c.group() },
    'separator',
    { id: 'recent', label: 'Closed conversations', icon: 'recent', run: c.toggleRecent },
    ...closed.slice(0, 5).map((p): MenuItem => ({ id: `reopen-project-${p.id}`, label: `Reopen project: ${p.name}`, icon: 'folder-open', run: () => c.reopenProject(p.id) })),
    'separator',
    { id: 'close-selected', label: 'Close selected', icon: 'close', disabled: s.selectedCount === 0, run: c.closeSelected },
    { id: 'quit', label: 'Quit (sessions keep running)', icon: 'quit', run: c.quit },
    { id: 'stop-all-quit', label: 'Stop all sessions and quit', icon: 'quit', run: c.stopAllAndQuit }
  ]
}

export function editMenu(c: Commands, s: MenuState): MenuEntry[] {
  return [
    { id: 'undo', label: s.undoLabel ? `Undo ${s.undoLabel}` : 'Undo', icon: 'undo', disabled: !s.canUndo, run: c.undo },
    { id: 'redo', label: s.redoLabel ? `Redo ${s.redoLabel}` : 'Redo', icon: 'redo', disabled: !s.canRedo, run: c.redo },
    'separator',
    { id: 'copy', label: 'Copy', icon: 'copy', disabled: !s.canCopy, run: () => c.copy() },
    { id: 'paste', label: 'Paste', icon: 'paste', disabled: !s.canFind, run: () => c.paste() },
    { id: 'find', label: 'Find in terminal', icon: 'find', disabled: !s.canFind, run: () => c.find() },
    'separator',
    { id: 'select-all', label: 'Select all', icon: 'select-all', run: c.selectAll }
  ]
}

export function viewMenu(c: Commands, s: MenuState): MenuEntry[] {
  return [
    { id: 'open-palette', label: 'Command palette…', icon: 'palette', run: c.openPalette },
    'separator',
    { id: 'zoom-in', label: 'Zoom in', icon: 'plus', run: c.zoomIn },
    { id: 'zoom-out', label: 'Zoom out', icon: 'minus', run: c.zoomOut },
    { id: 'zoom-reset', label: 'Actual size', icon: 'actual-size', run: c.zoomReset },
    { id: 'fit-view', label: 'Fit view', icon: 'fit', run: c.fitView },
    { id: 'tidy', label: 'Tidy canvas', icon: 'tidy', run: () => c.tidy() },
    'separator',
    { id: 'toggle-sidebar', label: 'Sessions sidebar', icon: 'sidebar', checked: s.sidebar, run: () => c.togglePref('sidebar') },
    { id: 'toggle-board', label: 'Board view', icon: 'board', checked: !!s.board, run: c.toggleBoard },
    { id: 'toggle-focus', label: 'Focus view', icon: 'grid', checked: !!s.focus, run: () => c.toggleFocus() },
    { id: 'toggle-git', label: 'Git panel', icon: 'branch', checked: !!s.gitPanel, run: () => c.toggleGit() },
    { id: 'review-inbox', label: 'Review inbox…', icon: 'checklist', run: () => toggleReviewInbox() },
    { id: 'file-shelf', label: 'Files shelf…', icon: 'file', run: () => toggleFileShelf() },
    { id: 'toggle-minimap', label: 'Minimap', icon: 'map', checked: s.minimap, run: () => c.togglePref('minimap') },
    { id: 'toggle-legend', label: 'Link legend', icon: 'link', checked: s.legend, run: () => c.togglePref('legend') }
  ]
}

export function settingsMenu(c: Commands, s: MenuState): MenuEntry[] {
  return [
    { id: 'open-settings', label: 'Settings…', icon: 'settings', run: c.openSettings },
    'separator',
    { id: 'toggle-snap', label: 'Snap to grid', icon: 'grid', checked: s.snap, run: () => c.togglePref('snap') }
  ]
}

/**
 * Where a feature adds its own entries to the canvas menu, between the things that create nodes and the things that
 * arrange them. Nothing that doesn't work yet belongs here.
 */
export function canvasExtensions(c: Commands, at: Point): MenuItem[] {
  return [
    { id: 'new-trigger', label: 'New trigger…', icon: 'trigger', run: () => c.newTriggerForm(at) },
    { id: 'new-from-recipe', label: 'New from recipe…', icon: 'team', run: () => openRecipePicker(at) },
    { id: 'try-approach', label: 'Try another approach…', icon: 'branch', run: () => openTryApproach() },
    openDocumentEntry(at)
  ]
}

export function canvasMenu(c: Commands, s: MenuState, at: Point): MenuEntry[] {
  const extensions = canvasExtensions(c, at)
  return [
    { id: 'new-terminal', label: 'New terminal', icon: 'terminal', run: () => c.newTerminal(at) },
    ...terminalProfileItems((profile) => c.newTerminal(at, undefined, profile)),
    { id: 'new-terminal-form', label: 'New terminal in a folder…', icon: 'folder', run: () => c.newTerminalForm(at) },
    { id: 'new-ssh', label: 'SSH to host…', icon: 'server', run: () => c.newSshForm(at) },
    { id: 'new-claude', label: 'New Claude Code…', icon: 'claude', run: () => c.newClaudeForm(at) },
    { id: 'new-codex', label: 'New Codex…', icon: 'codex', run: () => c.newCodexForm(at) },
    { id: 'new-run', label: 'New run command…', icon: 'run', run: () => c.newRunForm(at) },
    { id: 'new-run-config', label: 'New run configuration…', icon: 'launch', run: () => c.newRunConfigForm(at) },
    { id: 'new-browser', label: 'New browser', icon: 'browser', run: () => c.newBrowser(at) },
    { id: 'spawn-team', label: 'New team…', icon: 'team', run: () => c.spawnTeamForm(at) },
    ...extensions,
    'separator',
    { id: 'new-sticky', label: 'New note', icon: 'note', run: () => c.newSticky(at) },
    { id: 'new-whiteboard', label: 'New whiteboard', icon: 'whiteboard', run: () => c.newWhiteboard(at) },
    { id: 'group', label: s.selectedCount ? 'Group selection' : 'New group', icon: 'group', run: () => c.group(at) },
    ...(s.selectedCount ? [{ id: 'save-recipe', label: 'Save selection as recipe…', icon: 'note' as const, run: () => openRecipeSave() }] : []),
    'separator',
    { id: 'select-all', label: 'Select all', icon: 'select-all', run: c.selectAll },
    { id: 'fit-view', label: 'Fit view', icon: 'fit', run: c.fitView },
    { id: 'tidy', label: s.selectedCount > 1 ? 'Tidy selection' : 'Tidy canvas', icon: 'tidy', run: () => c.tidy() },
    'separator',
    { id: 'recent', label: 'Closed conversations', icon: 'recent', run: c.toggleRecent }
  ]
}

export function nodeMenu(
  c: Commands,
  node: CanvasNode,
  status: AgentStatus | null,
  ctx: { at: Point; canCopy: boolean; canRestart: boolean }
): MenuEntry[] {
  const close = (label: string, confirm?: string): MenuItem => ({
    id: 'close',
    label,
    icon: 'close',
    danger: true,
    confirm,
    run: () => c.closeNode(node.id)
  })
  if (node.kind === 'sticky') return [close('Delete note')]
  if (node.kind === 'file') return fileNodeMenu(node, close('Remove from canvas'))
  if (node.kind === 'whiteboard') return [close('Delete whiteboard')]
  if (node.kind === 'reader') return readerMenu(node, { rename: () => c.renameNode(node.id), close: close('Close reader') })
  if (node.kind === 'trigger') {
    const armed = isArmed(node)
    return [
      armed
        ? { id: 'disarm-trigger', label: 'Disarm', icon: 'stop', run: () => c.disarmTrigger(node.id) }
        : { id: 'arm-trigger', label: 'Arm…', icon: 'trigger', run: () => c.armTrigger(node.id) },
      { id: 'run-trigger', label: 'Run now', icon: 'run', disabled: !armed, run: () => c.runTriggerNow(node.id) },
      { id: 'edit-trigger', label: 'Edit…', icon: 'edit', run: () => c.editTrigger(node.id) },
      { id: 'rename', label: 'Rename', icon: 'edit', run: () => c.renameNode(node.id) },
      close('Delete trigger')
    ]
  }
  if (node.kind === 'browser') {
    return [
      { id: 'browser-reload', label: 'Reload', icon: 'refresh', run: () => c.reloadBrowser(node.id) },
      node.held
        ? { id: 'browser-hand-back', label: 'Hand back to agents', icon: 'link', run: () => c.setBrowserHeld(node.id, false) }
        : { id: 'browser-take-control', label: 'Take control', icon: 'stop', run: () => c.setBrowserHeld(node.id, true) },
      { id: 'rename', label: 'Rename', icon: 'edit', run: () => c.renameNode(node.id) },
      'separator',
      close('Close')
    ]
  }
  if (node.kind === 'group') {
    return [
      { id: 'new-terminal', label: 'New terminal here', icon: 'terminal', run: () => c.newTerminal(ctx.at, node.id) },
      { id: 'new-claude', label: 'New Claude Code here…', icon: 'claude', run: () => c.newClaudeForm(ctx.at, node.id) },
      { id: 'new-codex', label: 'New Codex here…', icon: 'codex', run: () => c.newCodexForm(ctx.at, node.id) },
      { id: 'new-run', label: 'New run command here…', icon: 'run', run: () => c.newRunForm(ctx.at, node.id) },
      { id: 'new-browser', label: 'New browser here', icon: 'browser', run: () => c.newBrowser(ctx.at, node.id) },
      'separator',
      ...(node.worktree ? [{ id: 'open-git', label: 'Open in Git panel', icon: 'branch' as const, run: () => c.toggleGit(node.worktree!.path) }] : []),
      { id: 'rename', label: 'Rename', icon: 'edit', run: () => c.renameNode(node.id) },
      { id: 'tidy-group', label: 'Tidy group', icon: 'tidy', run: () => c.tidy([node.id]) },
      close('Remove group')
    ]
  }
  const busy = status === 'working' ? 'Still working. Close anyway?' : status === 'needs-you' ? 'Waiting on you. Close anyway?' : undefined
  return [
    { id: 'copy', label: 'Copy', icon: 'copy', disabled: !ctx.canCopy, run: () => c.copy(node.id) },
    { id: 'paste', label: 'Paste', icon: 'paste', run: () => c.paste(node.id) },
    { id: 'find', label: 'Find', icon: 'find', run: () => c.find(node.id) },
    'separator',
    { id: 'refresh-window', label: 'Refresh the view', icon: 'refresh', run: () => c.refreshWindow(node.id) },
    { id: 'toggle-maximize', label: 'Maximize or restore', icon: 'maximize', run: () => c.toggleMaximize(node.id) },
    { id: 'show-in-focus', label: 'Show in focus view', icon: 'grid', run: () => c.toggleFocus(node.id) },
    { id: 'open-git', label: 'Open in Git panel', icon: 'branch', run: () => c.toggleGit(node.cwd) },
    ...openPlanEntry(node),
    ...(node.kind === 'claude' ? [{ id: 'continue-handoff', label: 'Continue with another agent…', icon: 'arrow-right' as const, run: () => openHandoff({ type: 'node', nodeId: node.id }, node.title) }] : []),
    ...(node.kind === 'claude' ? [{ id: 'try-approach', label: 'Try another approach…', icon: 'branch' as const, run: () => openTryApproach({ source: node.cwd, brief: node.prompt }) }] : []),
    ...(node.kind === 'run' && !node.launch ? [{ id: 'edit-command', label: 'Edit command…', icon: 'edit' as const, run: () => c.editRunCommand(node.id) }] : []),
    { id: 'rename', label: 'Rename', icon: 'edit', run: () => c.renameNode(node.id) },
    ...(ctx.canRestart ? [{ id: 'restart', label: 'Restart', icon: 'restart' as const, run: () => c.restartNode(node.id) }] : []),
    close('Close', busy)
  ]
}

const MARGIN = 8

/**
 * Keeps a menu on screen, preferring to stay against the point that opened it. A menu taller than the window is
 * capped at the window's height less the margins (its CSS max-height) and scrolls, so it's placed at that height.
 */
export function clampToViewport(
  at: Point,
  size: { width: number; height: number },
  view: { width: number; height: number }
): Point {
  const height = Math.min(size.height, view.height - 2 * MARGIN)
  return {
    x: Math.max(MARGIN, Math.min(at.x, view.width - size.width - MARGIN)),
    y: Math.max(MARGIN, Math.min(at.y, view.height - height - MARGIN))
  }
}
