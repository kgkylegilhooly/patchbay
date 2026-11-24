import type { IconName } from './iconPaths'
import type { Bindable } from './keys'
import type { Commands, MenuState } from './menus'
import { toggleSearch } from './searchUi'
import { openRecipePicker, openRecipeSave } from './recipeUi'
import { toggleReviewInbox } from './reviewInboxUi'
import { toggleFileShelf } from './fileShelfUi'
import { offerCommand } from './agentChoice'
import { openComparisons, openTryApproach } from './compareUi'
import { openProjects } from './projectsUi'
import { jumpToNext } from './needsYouUi'
import { pickDocument } from './reader/readerUi'
import { cycleRegion } from './a11y/regions'
import { copyDiagnostics, openLogFolder } from './diagnostics/diagnosticsUi'
import { VIEW_SLOTS } from './savedViews'

export type ActionSection = 'New' | 'Canvas' | 'Window' | 'View' | 'App'

/**
 * Everything the app can do from the keyboard. The palette and the shortcuts both read this one list, and menu items
 * use the same ids, so a shortcut shown in a menu is always the one that works.
 */
export interface Action extends Bindable {
  section: ActionSection
  /** Other words people might search for. */
  keywords?: string[]
  icon?: IconName
  /** Whether it can do anything right now. It's left out of the palette, and its key does nothing, when it can't. */
  ready?: (s: MenuState) => boolean
  run: (c: Commands) => void
}

const hasWindow = (s: MenuState): boolean => s.hasWindow
const hasSelection = (s: MenuState): boolean => s.selectedCount > 0

export const ACTIONS: Action[] = [
  { id: 'new-terminal', section: 'New', label: 'New terminal', icon: 'terminal', key: 'Ctrl+Shift+T', keywords: ['shell', 'console'], run: (c) => c.newTerminal() },
  { id: 'new-terminal-form', section: 'New', label: 'New terminal in a folder…', icon: 'folder', keywords: ['shell', 'command'], run: (c) => c.newTerminalForm() },
  { id: 'new-ssh', section: 'New', label: 'SSH to host…', icon: 'server', keywords: ['remote', 'server', 'host', 'terminal'], run: (c) => c.newSshForm() },
  { id: 'new-claude', section: 'New', label: 'New Claude Code…', icon: 'claude', key: 'Ctrl+Shift+C', keywords: ['agent', 'session'], run: (c) => c.newClaudeForm() },
  { id: 'new-codex', section: 'New', label: 'New Codex…', icon: 'codex', keywords: ['agent', 'session', 'openai'], run: (c) => c.newCodexForm() },
  { id: 'new-run', section: 'New', label: 'New run command…', icon: 'run', keywords: ['server', 'script', 'dev'], run: (c) => c.newRunForm() },
  { id: 'new-run-config', section: 'New', label: 'New run configuration…', icon: 'launch', keywords: ['launch.json', 'vscode', 'debug', 'server'], run: (c) => c.newRunConfigForm() },
  { id: 'new-trigger', section: 'New', label: 'New trigger…', icon: 'trigger', keywords: ['schedule', 'cron', 'timer', 'interval', 'repeat'], run: (c) => c.newTriggerForm() },
  { id: 'new-browser', section: 'New', label: 'New browser', icon: 'browser', keywords: ['web', 'page', 'url', 'site', 'localhost'], run: (c) => c.newBrowser() },
  { id: 'new-sticky', section: 'New', label: 'New note', icon: 'note', key: 'Ctrl+Shift+N', keywords: ['sticky', 'text'], run: (c) => c.newSticky() },
  { id: 'new-whiteboard', section: 'New', label: 'New whiteboard', icon: 'whiteboard', key: 'Ctrl+Shift+D', keywords: ['draw', 'sketch', 'paint', 'diagram', 'canvas'], run: (c) => c.newWhiteboard() },
  { id: 'spawn-team', section: 'New', label: 'New team…', icon: 'team', keywords: ['spawn', 'agents', 'lead', 'workstreams', 'parallel'], run: (c) => c.spawnTeamForm() },
  { id: 'new-from-recipe', section: 'New', label: 'New from recipe…', icon: 'team', keywords: ['template', 'recipe', 'worktree', 'implement', 'review', 'setup'], run: () => openRecipePicker() },
  { id: 'try-approach', section: 'New', label: 'Try another approach…', icon: 'branch', keywords: ['compare', 'attempt', 'race', 'alternative', 'worktree', 'variant'], run: () => openTryApproach() },
  { id: 'comparisons', section: 'View', label: 'Comparisons…', icon: 'branch', keywords: ['compare', 'attempts', 'approach', 'winner', 'diff', 'verification'], run: () => openComparisons() },
  { id: 'open-document', section: 'New', label: 'Open document…', icon: 'note', keywords: ['markdown', 'md', 'plan', 'reader', 'read', 'file', 'comment'], run: () => void pickDocument() },
  { id: 'new-project', section: 'New', label: 'New project…', icon: 'project', keywords: ['tab', 'workspace'], run: (c) => c.newProject() },

  { id: 'group', section: 'Canvas', label: 'Group selection, or new group', icon: 'group', key: 'Ctrl+Shift+G', run: (c) => c.group() },
  { id: 'select-all', section: 'Canvas', label: 'Select all', icon: 'select-all', key: 'Ctrl+A', run: (c) => c.selectAll() },
  { id: 'close-selected', section: 'Canvas', label: 'Close selected', icon: 'close', keywords: ['delete', 'remove'], ready: hasSelection, run: (c) => c.closeSelected() },
  { id: 'tidy', section: 'Canvas', label: 'Tidy canvas', icon: 'tidy', keywords: ['arrange', 'layout', 'grid'], run: (c) => c.tidy() },
  { id: 'save-recipe', section: 'Canvas', label: 'Save selection as recipe…', icon: 'note', keywords: ['template', 'recipe', 'reuse'], ready: hasSelection, run: () => openRecipeSave() },
  { id: 'undo', section: 'Canvas', label: 'Undo layout change', icon: 'undo', key: 'Ctrl+Z', ready: (s) => s.canUndo, run: (c) => c.undo() },
  { id: 'redo', section: 'Canvas', label: 'Redo layout change', icon: 'redo', key: 'Ctrl+Y', ready: (s) => s.canRedo, run: (c) => c.redo() },
  { id: 'focus-left', section: 'Canvas', label: 'Move to the window on the left', icon: 'arrow-left', key: 'Ctrl+Shift+Left', keywords: ['focus', 'next'], run: (c) => c.moveFocus('left') },
  { id: 'focus-right', section: 'Canvas', label: 'Move to the window on the right', icon: 'arrow-right', key: 'Ctrl+Shift+Right', keywords: ['focus', 'next'], run: (c) => c.moveFocus('right') },
  { id: 'focus-up', section: 'Canvas', label: 'Move to the window above', icon: 'arrow-up', key: 'Ctrl+Shift+Up', keywords: ['focus', 'next'], run: (c) => c.moveFocus('up') },
  { id: 'focus-down', section: 'Canvas', label: 'Move to the window below', icon: 'arrow-down', key: 'Ctrl+Shift+Down', keywords: ['focus', 'next'], run: (c) => c.moveFocus('down') },

  { id: 'copy', section: 'Window', label: 'Copy', icon: 'copy', fixedKey: 'Ctrl+C', ready: (s) => s.canCopy, run: (c) => c.copy() },
  { id: 'paste', section: 'Window', label: 'Paste', icon: 'paste', fixedKey: 'Ctrl+V', ready: (s) => s.canFind, run: (c) => c.paste() },
  { id: 'find', section: 'Window', label: 'Find in terminal', icon: 'find', fixedKey: 'Ctrl+F', keywords: ['search'], ready: (s) => s.canFind, run: (c) => c.find() },
  { id: 'refresh-window', section: 'Window', label: 'Refresh this window', icon: 'refresh', key: 'Ctrl+Shift+R', keywords: ['redraw', 'repaint', 'rebuild'], ready: hasWindow, run: (c) => c.refreshWindow() },
  { id: 'name-with-ai', section: 'Window', label: 'Name this window with AI', icon: 'sparkle', keywords: ['title', 'rename'], ready: (s) => s.canName, run: (c) => c.nameWithAi() },
  { id: 'rename-window', section: 'Window', label: 'Rename this window', icon: 'edit', key: 'F2', canvasOnly: true, keywords: ['title', 'name'], ready: hasWindow, run: (c) => c.renameWindow() },
  { id: 'restart-window', section: 'Window', label: 'Restart this window', icon: 'restart', keywords: ['start', 'again', 'rerun', 'resume'], ready: (s) => !!s.canRestart, run: (c) => c.restartWindow() },
  { id: 'close-window', section: 'Window', label: 'Close this window', icon: 'close', keywords: ['delete', 'remove', 'end', 'quit'], ready: hasWindow, run: (c) => c.closeWindow() },
  { id: 'toggle-chat', section: 'Window', label: 'Show this window as a chat, or as its terminal', icon: 'note', keywords: ['chat', 'conversation', 'terminal', 'view'], ready: hasWindow, run: (c) => c.toggleChat() },
  { id: 'copy-folder-path', section: 'Window', label: "Copy this window's folder path", icon: 'copy', keywords: ['cwd', 'directory', 'path', 'folder'], ready: hasWindow, run: (c) => c.copyFolderPath() },
  { id: 'toggle-maximize', section: 'Window', label: 'Maximize or restore this window', icon: 'maximize', key: 'F11', keywords: ['fullscreen', 'expand'], ready: hasWindow, run: (c) => c.toggleMaximize() },
  { id: 'font-larger', section: 'Window', label: "Larger text in this window", icon: 'text-larger', key: 'Ctrl+Shift+=', keywords: ['font', 'size', 'zoom'], ready: hasWindow, run: (c) => c.stepFont(1) },
  { id: 'font-smaller', section: 'Window', label: "Smaller text in this window", icon: 'text-smaller', key: 'Ctrl+Shift+-', keywords: ['font', 'size', 'zoom'], ready: hasWindow, run: (c) => c.stepFont(-1) },
  { id: 'font-reset', section: 'Window', label: "This window's text back to the global size", icon: 'text-size', key: 'Ctrl+Shift+0', keywords: ['font', 'size', 'reset'], ready: hasWindow, run: (c) => c.resetFont() },

  { id: 'zoom-in', section: 'View', label: 'Zoom in', icon: 'plus', key: 'Ctrl+=', run: (c) => c.zoomIn() },
  { id: 'zoom-out', section: 'View', label: 'Zoom out', icon: 'minus', key: 'Ctrl+-', run: (c) => c.zoomOut() },
  { id: 'zoom-reset', section: 'View', label: 'Actual size', icon: 'actual-size', key: 'Ctrl+0', keywords: ['zoom', '100'], run: (c) => c.zoomReset() },
  { id: 'fit-view', section: 'View', label: 'Fit view', icon: 'fit', key: 'Ctrl+Shift+F', keywords: ['zoom', 'everything'], run: (c) => c.fitView() },
  { id: 'toggle-sidebar', section: 'View', label: 'Sessions sidebar', icon: 'sidebar', key: 'Ctrl+Shift+E', keywords: ['list', 'panel', 'status'], run: (c) => c.togglePref('sidebar') },
  { id: 'toggle-focus', section: 'View', label: 'Focus view', icon: 'grid', key: 'Ctrl+Shift+L', keywords: ['split', 'panes', 'layout', 'fullscreen', 'tile'], run: (c) => c.toggleFocus() },
  { id: 'toggle-board', section: 'View', label: 'Board view', icon: 'board', key: 'Ctrl+Shift+B', keywords: ['kanban', 'columns', 'cards', 'issues', 'github'], run: (c) => c.toggleBoard() },
  { id: 'toggle-git', section: 'View', label: 'Git panel', icon: 'branch', key: 'Ctrl+Shift+H', keywords: ['commit', 'stage', 'branch', 'push', 'pull', 'history', 'diff'], run: (c) => c.toggleGit() },
  { id: 'toggle-minimap', section: 'View', label: 'Minimap', icon: 'map', keywords: ['overview'], run: (c) => c.togglePref('minimap') },
  { id: 'toggle-legend', section: 'View', label: 'Link legend', icon: 'link', keywords: ['key', 'cables'], run: (c) => c.togglePref('legend') },
  // Saved views, per project (see savedViews.ts). Shift picks the digit by its key, so these work on any layout.
  ...VIEW_SLOTS.map((n): Action => ({ id: `view-go-${n}`, section: 'View', label: `Go to saved view ${n}`, icon: 'fit', key: `Alt+${n}`, keywords: ['bookmark', 'jump', 'place'], run: (c) => c.goToView(n) })),
  ...VIEW_SLOTS.map((n): Action => ({ id: `view-save-${n}`, section: 'View', label: `Save this view as ${n}`, icon: 'pin', key: `Alt+Shift+${n}`, keywords: ['bookmark', 'remember', 'place'], run: (c) => c.saveView(n) })),
  { id: 'toggle-snap', section: 'View', label: 'Snap to grid', icon: 'grid', keywords: ['align'], run: (c) => c.togglePref('snap') },
  { id: 'search', section: 'View', label: 'Search conversations and notes…', icon: 'find', key: 'Ctrl+Shift+S', keywords: ['find', 'transcript', 'history', 'closed', 'messages', 'handoff', 'decision'], run: () => toggleSearch() },
  { id: 'review-inbox', section: 'View', label: 'Review inbox…', icon: 'checklist', keywords: ['review', 'tasks', 'diff', 'comments', 'accept', 'fixes', 'submitted'], run: () => toggleReviewInbox() },
  { id: 'file-shelf', section: 'View', label: 'Files shelf…', icon: 'file', keywords: ['files', 'shared', 'pasted', 'images', 'screenshots', 'attachments', 'documents', 'pin'], run: () => toggleFileShelf() },
  { id: 'recent', section: 'View', label: 'Closed conversations', icon: 'recent', keywords: ['closed', 'recent', 'history', 'reopen', 'transcript'], run: (c) => c.toggleRecent() },
  { id: 'next-needs-you', section: 'View', label: 'Next needing you', icon: 'arrow-right', key: 'Ctrl+Shift+J', keywords: ['attention', 'waiting', 'needs you', 'unread', 'jump', 'peek', 'reply', 'inbox'], run: (c) => void jumpToNext(c) },

  { id: 'open-palette', section: 'App', label: 'Command palette', icon: 'palette', key: 'Ctrl+K', overTerminal: true, keywords: ['search', 'commands', 'actions'], run: (c) => c.openPalette() },
  { id: 'next-region', section: 'App', label: 'Next part of the app (leaves a terminal)', icon: 'arrow-right', key: 'F6', keywords: ['leave', 'exit', 'escape', 'terminal', 'focus', 'menu', 'sidebar', 'dock', 'region', 'pane'], run: () => void cycleRegion(1) },
  { id: 'prev-region', section: 'App', label: 'Previous part of the app', icon: 'arrow-left', key: 'Shift+F6', keywords: ['leave', 'exit', 'terminal', 'focus', 'menu', 'sidebar', 'dock', 'region', 'pane'], run: () => void cycleRegion(-1) },
  { id: 'open-settings', section: 'App', label: 'Settings…', icon: 'settings', key: 'Ctrl+,', overTerminal: true, keywords: ['preferences', 'options', 'shortcuts'], run: (c) => c.openSettings() },
  { id: 'copy-diagnostics', section: 'App', label: 'Copy diagnostics', icon: 'copy', keywords: ['bug', 'report', 'version', 'support', 'debug', 'hooks', 'log'], run: () => copyDiagnostics() },
  { id: 'open-log-folder', section: 'App', label: 'Open log folder', icon: 'folder', keywords: ['logs', 'bug', 'report', 'debug', 'crash'], run: () => openLogFolder() },
  { id: 'close-project', section: 'App', label: 'Close this project', icon: 'folder-closed', keywords: ['hide', 'tab'], ready: (s) => s.canCloseProject, run: (c) => c.closeProject() },
  { id: 'manage-projects', section: 'App', label: 'Projects…', icon: 'project', keywords: ['manage', 'archive', 'unarchive', 'storage', 'disk', 'tabs', 'rename', 'delete', 'reopen'], run: () => openProjects() },
  { id: 'move-project-left', section: 'App', label: "Move this project's tab left", icon: 'arrow-left', keywords: ['reorder', 'tab', 'order'], run: (c) => c.moveProjectTab(-1) },
  { id: 'move-project-right', section: 'App', label: "Move this project's tab right", icon: 'arrow-right', keywords: ['reorder', 'tab', 'order'], run: (c) => c.moveProjectTab(1) },
  // Sessions live in the background host, so quitting leaves them running. Ending them is its own, separate choice.
  { id: 'quit', section: 'App', label: 'Quit (sessions keep running)', icon: 'quit', keywords: ['exit', 'close', 'leave running', 'background'], run: (c) => c.quit() },
  { id: 'stop-all-quit', section: 'App', label: 'Stop all sessions and quit', icon: 'quit', keywords: ['exit', 'end', 'kill', 'terminate', 'host'], run: (c) => c.stopAllAndQuit() }
]

export const ACTION_SECTIONS: ActionSection[] = ['New', 'Canvas', 'Window', 'View', 'App']

/** Besides everything under App, what still acts while the board covers the canvas. */
const OVER_BOARD = new Set(['toggle-board', 'toggle-git', 'review-inbox'])

/** Whether an action means anything with the board on screen. The rest would change a canvas nobody can see. */
export function worksOverBoard(a: Action): boolean {
  return a.section === 'App' || OVER_BOARD.has(a.id)
}

/** Whether an action can run now: its own readiness, and nothing aimed at the canvas while the board hides it. */
export function actionReady(a: Action, s: MenuState): boolean {
  if (s.board && !worksOverBoard(a)) return false
  if (!offerCommand(a.id)) return false
  return a.ready?.(s) ?? true
}

export function actionById(id: string): Action | undefined {
  return ACTIONS.find((a) => a.id === id)
}
