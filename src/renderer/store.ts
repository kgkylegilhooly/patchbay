import { create } from 'zustand'
import type { BrowserState, NodeError, NodeMessage, PendingApproval, PortInfo, RunResult } from '../shared/contract'
import { isSessionNode, type AgentStatus, type CanvasDoc, type CanvasNode, type CanvasOp, type WhiteboardShape } from '../shared/model'
import type { UsageState } from '../shared/usage'
import { bridge } from './bridge'
import { playChime } from './chime'
import type { Overrides } from './keys'
import type { Pane } from './focusLayout'
import { newTerminal } from './newNodes'
import { loadPrefs, type TerminalLook } from './prefs'
import { EMPTY_HISTORY, entryFor, recordEntry, stepBack, stepForward, type History } from './undoHistory'
import type { UsageMode } from './usageView'
import { svgToPng } from './whiteboardImage'
import { joinBoardEdit, joinNoteEdit, type AgentBoardEdits, type AgentNoteEdits } from './noteEdit'
import { PULSE_MS, pulseCable } from './cableMotion'
import { shareDoc } from './docShare'
import { noteJoined } from './sessionSync'

/** As many as main keeps. */
const MESSAGES_KEPT = 300

/**
 * Each whiteboard's shapes, as main last sent them. A doc arrives with its boards' shapes left out, and they go back
 * in from here, as the same array while they're unchanged, so a board only redraws when its own shapes change.
 */
const boardShapes = new Map<string, WhiteboardShape[]>()
function withBoardShapes(doc: CanvasDoc): CanvasDoc {
  if (!doc.nodes.some((n) => n.kind === 'whiteboard')) return doc
  return { ...doc, nodes: doc.nodes.map((n) => (n.kind === 'whiteboard' ? { ...n, shapes: boardShapes.get(n.id) ?? n.shapes } : n)) }
}

interface State {
  doc: CanvasDoc | null
  statuses: Record<string, AgentStatus>
  errors: Record<string, NodeError>
  approvals: PendingApproval[]
  /** Goes up each time a node's session is replaced, which tells its terminal to attach again. */
  epochs: Record<string, number>
  /** Goes up each time a window's view is rebuilt. The session behind it carries on. */
  refreshes: Record<string, number>
  /** A node a menu asked to rename. Its title field picks this up. */
  renaming: string | null
  terminalFontSize: number
  terminalLook: TerminalLook
  /** Agent windows showing their conversation instead of their terminal. */
  chatView: Record<string, boolean>
  /** The focus view's panes while it's on, or null for the canvas. */
  focus: Pane | null
  /** Where each window in the focus view is drawn, so its card can move there. */
  focusSlots: Record<string, HTMLElement>
  usageMode: UsageMode
  /** The sessions to look at, across every project. */
  attention: string[]
  usage: UsageState
  runs: Record<string, RunResult>
  ports: Record<string, PortInfo[]>
  /** Each browser node's live page. */
  browsers: Record<string, BrowserState>
  /** When each session last did something, since the app started. */
  activity: Record<string, number>
  /** The window filling the canvas. This is only how it's being viewed, so it's never saved. */
  maximized: string | null
  /** Windows waiting on a title from Claude. */
  naming: Record<string, boolean>
  /** Why a window couldn't be named, until dismissed or tried again. */
  namingError: Record<string, string>
  /** Each project's own undo steps. */
  histories: Record<string, History>
  keyOverrides: Overrides
  /** Settings is waiting for a key to bind, so no shortcut should act on it. */
  capturingKey: boolean
  /** The git panel is showing, and the folder it should open on, if one was asked for. */
  gitOpen: boolean
  gitFolder: string | null
  /** The board view covers the canvas. The canvas stays mounted underneath, so no terminal is rebuilt. */
  boardOpen: boolean
  /** A trigger's own buttons asking the canvas for its edit or arm form. */
  triggerAsk: { kind: 'edit' | 'arm'; id: string } | null
  /** Why a launch.json run didn't start, until dismissed or run again. */
  runProblem: Record<string, string>
  /** Cables carrying a message right now, by edge id. `at` tells one message from the next on the same cable. */
  pulses: Record<string, { at: number; reverse: boolean }>
  /** What nodes have sent each other since the app started, newest last. */
  messages: NodeMessage[]
  /** Agents' changes to notes, by note, until the person keeps or undoes them. */
  noteEdits: Record<string, AgentNoteEdits>
  /** Agents' drawing on whiteboards, by board, likewise. */
  boardEdits: Record<string, AgentBoardEdits>
}

export const useStore = create<State>(() => ({
  doc: null,
  statuses: {},
  errors: {},
  approvals: [],
  epochs: {},
  refreshes: {},
  renaming: null,
  terminalFontSize: loadPrefs().fontSize,
  terminalLook: loadPrefs().terminal,
  chatView: {},
  focus: null,
  focusSlots: {},
  usageMode: loadPrefs().usageMode,
  attention: [],
  usage: { plan: null, nodes: {}, budget: null },
  runs: {},
  ports: {},
  browsers: {},
  activity: {},
  maximized: null,
  naming: {},
  namingError: {},
  histories: {},
  keyOverrides: loadPrefs().keys,
  capturingKey: false,
  gitOpen: false,
  gitFolder: null,
  boardOpen: false,
  triggerAsk: null,
  runProblem: {},
  pulses: {},
  messages: [],
  noteEdits: {},
  boardEdits: {}
}))

/** Loads everything from main, subscribing first so nothing that changes meanwhile is missed. */
export async function connectStore(): Promise<void> {
  bridge.onBoardShapes((id, shapes) => boardShapes.set(id, shapes))
  bridge.onDoc((doc) => useStore.setState((s) => ({ doc: shareDoc(s.doc, withBoardShapes(doc)) })))
  bridge.onStatus((id, status) =>
    useStore.setState((s) => {
      const statuses = { ...s.statuses }
      if (status) statuses[id] = status
      else delete statuses[id]
      return { statuses }
    })
  )
  bridge.onNodeError((id, error) =>
    useStore.setState((s) => {
      const errors = { ...s.errors }
      if (error) errors[id] = error
      else delete errors[id]
      return { errors }
    })
  )
  bridge.onApprovals((approvals) => useStore.setState({ approvals }))
  bridge.onChime(playChime)
  bridge.onBoardEdit((edit) => useStore.setState((s) => ({ boardEdits: { ...s.boardEdits, [edit.id]: joinBoardEdit(s.boardEdits[edit.id], edit) } })))
  bridge.onNoteEdit((edit) => useStore.setState((s) => ({ noteEdits: { ...s.noteEdits, [edit.id]: joinNoteEdit(s.noteEdits[edit.id], edit) } })))
  bridge.onMessage((message) => {
    const { from, to } = message
    useStore.setState((s) => ({ messages: [...s.messages, message].slice(-MESSAGES_KEPT) }))
    const cable = pulseCable(useStore.getState().doc?.edges ?? [], from, to)
    if (!cable) return
    const at = Date.now()
    useStore.setState((s) => ({ pulses: { ...s.pulses, [cable.id]: { at, reverse: cable.reverse } } }))
    setTimeout(() => {
      useStore.setState((s) => {
        if (s.pulses[cable.id]?.at !== at) return s
        const { [cable.id]: _done, ...pulses } = s.pulses
        return { pulses }
      })
    }, PULSE_MS)
  })
  bridge.onRenderWhiteboard((requestId, svg, width, height) => {
    svgToPng(svg, width, height)
      .then(async (png) => bridge.whiteboardRendered(requestId, new Uint8Array(await png.arrayBuffer())))
      .catch(() => bridge.whiteboardRendered(requestId, null))
  })
  bridge.onReattach((ids) =>
    useStore.setState((s) => {
      const epochs = { ...s.epochs }
      for (const id of ids) epochs[id] = (epochs[id] ?? 0) + 1
      return { epochs }
    })
  )
  bridge.onAttention((attention) => useStore.setState({ attention }))
  void bridge.getAttention().then((attention) => useStore.setState({ attention }))
  bridge.onRun((id, run) => useStore.setState((s) => ({ runs: { ...s.runs, [id]: run } })))
  void bridge.getRuns().then((runs) => useStore.setState((s) => ({ runs: { ...runs, ...s.runs } })))
  bridge.onPorts((ports) => useStore.setState({ ports }))
  void bridge.getPorts().then((ports) => useStore.setState({ ports }))
  // Main has every change still showing, those that arrived while this loaded included, so they're rebuilt from it.
  void bridge.getAgentEdits().then(({ notes, boards }) => {
    const noteEdits: Record<string, AgentNoteEdits> = {}
    for (const e of notes) noteEdits[e.id] = joinNoteEdit(noteEdits[e.id], e)
    const boardEdits: Record<string, AgentBoardEdits> = {}
    for (const e of boards) boardEdits[e.id] = joinBoardEdit(boardEdits[e.id], e)
    useStore.setState({ noteEdits, boardEdits })
  })
  // Any that arrived while this loaded are newer, so they go after.
  void bridge.getMessages().then((earlier) => useStore.setState((s) => ({ messages: [...earlier, ...s.messages.filter((m) => !earlier.some((e) => e.at === m.at && e.from === m.from && e.to === m.to))].slice(-MESSAGES_KEPT) })))
  bridge.onBrowserState((id, state) =>
    useStore.setState((s) => {
      const browsers = { ...s.browsers }
      if (state) browsers[id] = state
      else delete browsers[id]
      return { browsers }
    })
  )
  void bridge.getBrowserStates().then((browsers) => useStore.setState((s) => ({ browsers: { ...browsers, ...s.browsers } })))
  bridge.onUsage((usage) => useStore.setState({ usage }))
  void bridge.getUsage().then((usage) => useStore.setState({ usage }))
  bridge.onActivity((id, at) => useStore.setState((s) => ({ activity: { ...s.activity, [id]: at } })))
  void bridge.getActivity().then((activity) => useStore.setState((s) => ({ activity: { ...activity, ...s.activity } })))

  const [doc, statuses, errors, approvals] = await Promise.all([
    bridge.getDoc(),
    bridge.getStatuses(),
    bridge.getErrors(),
    bridge.getApprovals()
  ])
  // Shapes already sent are newer than these, which were read before them.
  for (const n of doc.nodes) if (n.kind === 'whiteboard' && !boardShapes.has(n.id)) boardShapes.set(n.id, n.shapes)
  useStore.setState((s) => ({
    doc: s.doc ? withBoardShapes(s.doc) : doc,
    statuses: { ...statuses, ...s.statuses },
    errors,
    approvals
  }))
}

export function dispatch(op: CanvasOp): void {
  void bridge.dispatch(op)
}

export function patchNode(id: string, patch: Partial<CanvasNode>): void {
  dispatch({ op: 'patchNode', id, patch })
}

const historyOf = (s: State, projectId: string): History => s.histories[projectId] ?? EMPTY_HISTORY

/** Runs layout ops so they can be undone. For anything that can't touch a session: see undoHistory.ts. */
export function undoable(label: string, ops: CanvasOp[]): void {
  const s = useStore.getState()
  const entry = s.doc && entryFor(s.doc, label, ops)
  if (s.doc && entry) {
    const projectId = s.doc.activeProjectId
    useStore.setState((now) => ({ histories: { ...now.histories, [projectId]: recordEntry(historyOf(now, projectId), entry) } }))
  }
  for (const op of ops) dispatch(op)
}

export function undo(): void {
  const s = useStore.getState()
  if (!s.doc) return
  const projectId = s.doc.activeProjectId
  const step = stepBack(historyOf(s, projectId))
  if (!step) return
  useStore.setState((now) => ({ histories: { ...now.histories, [projectId]: step.history } }))
  dispatch({ op: 'restoreLayout', ...step.entry.undo })
}

export function redo(): void {
  const s = useStore.getState()
  if (!s.doc) return
  const projectId = s.doc.activeProjectId
  const step = stepForward(historyOf(s, projectId))
  if (!step) return
  useStore.setState((now) => ({ histories: { ...now.histories, [projectId]: step.history } }))
  dispatch({ op: 'restoreLayout', ...step.entry.redo })
}

export function undoState(): { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string } {
  const s = useStore.getState()
  const history = s.doc ? historyOf(s, s.doc.activeProjectId) : EMPTY_HISTORY
  return {
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undoLabel: history.past[history.past.length - 1]?.label,
    redoLabel: history.future[history.future.length - 1]?.label
  }
}

/** Closing a session can't be undone, because that would mean starting a process. Deleting a note, board or group can. */
export function closeNodes(ids: string[]): void {
  const nodes = useStore.getState().doc?.nodes ?? []
  const closing = new Set(ids)
  // A trigger isn't layout: undoing its deletion would bring back something that sends prompts.
  const sessions = nodes.filter((n) => closing.has(n.id) && (isSessionNode(n) || n.kind === 'trigger')).map((n) => n.id)
  // A browser's page and history can't be put back, so like a session it's closed for good.
  // A reader and a file icon are layout too: its file is only read, and its comments are kept apart from it.
  const layout = nodes.filter((n) => closing.has(n.id) && (n.kind === 'sticky' || n.kind === 'whiteboard' || n.kind === 'group' || n.kind === 'reader' || n.kind === 'file'))
  const pages = nodes.filter((n) => closing.has(n.id) && n.kind === 'browser').map((n) => n.id)
  if (pages.length) dispatch({ op: 'removeNodes', ids: pages, at: Date.now() })
  if (layout.length) {
    const kinds = new Set(layout.map((n) => n.kind))
    const label = kinds.size > 1 ? 'delete' : kinds.has('sticky') ? 'delete note' : kinds.has('whiteboard') ? 'delete whiteboard' : kinds.has('reader') ? 'close reader' : kinds.has('file') ? 'remove file' : 'remove group'
    undoable(label, [{ op: 'removeNodes', ids: layout.map((n) => n.id), at: Date.now() }])
  }
  if (sessions.length) dispatch({ op: 'removeNodes', ids: sessions, at: Date.now() })
}

export async function restartNode(id: string): Promise<void> {
  const result = await bridge.restartNode(id)
  // Still running unseen, so shown again: its own notice says so. See sessionSyncUi.tsx.
  if (!noteJoined(id, result)) noteRunProblem(id, result)
  useStore.setState((s) => ({ epochs: { ...s.epochs, [id]: (s.epochs[id] ?? 0) + 1 } }))
}

/** Opens and starts a terminal in a folder, just to the right of another window. */
export function openTerminalBeside(besideId: string, cwd: string, profile?: { id: string; name: string }): string | null {
  const doc = useStore.getState().doc
  const beside = doc?.nodes.find((n) => n.id === besideId)
  if (!doc || !beside) return null
  const node = newTerminal({ beside, group: null, doc }, crypto.randomUUID(), { cwd, ...(profile ? { profile } : {}) })
  dispatch({ op: 'addNode', node })
  void bridge.startNode(node.id).then((r) => noteRunProblem(node.id, r))
  return node.id
}

/** Starting a launch.json run can be refused, when its file no longer says something it can run. */
export function noteRunProblem(id: string, result: void | { ok: false; reason: string }): void {
  useStore.setState((s) => ({ runProblem: result ? { ...s.runProblem, [id]: result.reason } : dropKey(s.runProblem, id) }))
}

export function dismissRunProblem(id: string): void {
  useStore.setState((s) => ({ runProblem: dropKey(s.runProblem, id) }))
}

/** Throws away the window's terminal view and draws a new one from the session's output. The process isn't touched. */
export function refreshWindow(id: string): void {
  useStore.setState((s) => ({ refreshes: { ...s.refreshes, [id]: (s.refreshes[id] ?? 0) + 1 } }))
}

export function toggleMaximize(id: string): void {
  useStore.setState((s) => ({ maximized: s.maximized === id ? null : id }))
}

function dropKey<T>(record: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _gone, ...rest } = record
  return rest
}

export function dismissNamingError(id: string): void {
  useStore.setState((s) => ({ namingError: dropKey(s.namingError, id) }))
}

/** Only ever runs from a click or a key press, because each use spends a little plan quota. */
export async function nameWithAi(id: string): Promise<void> {
  if (useStore.getState().naming[id]) return
  useStore.setState((s) => ({ naming: { ...s.naming, [id]: true }, namingError: dropKey(s.namingError, id) }))
  let error: string | null = null
  try {
    const result = await bridge.nameWithAi(id)
    if (result.ok) undoable('rename', [{ op: 'patchNode', id, patch: { title: result.title } }])
    else error = result.reason
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  useStore.setState((s) => ({ naming: dropKey(s.naming, id), namingError: error ? { ...s.namingError, [id]: error } : s.namingError }))
}
