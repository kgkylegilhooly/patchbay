import { create } from 'zustand'
import type { BrowserState, NodeError, PendingApproval, PortInfo, RunResult } from '../shared/contract'
import { isSessionNode, type AgentStatus, type CanvasDoc, type CanvasNode, type CanvasOp } from '../shared/model'
import type { UsageState } from '../shared/usage'
import { bridge } from './bridge'
import { playChime } from './chime'
import type { Overrides } from './keys'
import type { Pane } from './focusLayout'
import { absolutePosition, newTerminal } from './newNodes'
import { loadPrefs, type TerminalLook } from './prefs'
import { EMPTY_HISTORY, entryFor, recordEntry, stepBack, stepForward, type History } from './undoHistory'
import type { UsageMode } from './usageView'
import { svgToPng } from './whiteboardImage'
import { PULSE_MS, pulseCable } from './cableMotion'

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
  pulses: {}
}))

/** Loads everything from main, subscribing first so nothing that changes meanwhile is missed. */
export async function connectStore(): Promise<void> {
  bridge.onDoc((doc) => useStore.setState({ doc }))
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
  bridge.onMessage((from, to) => {
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
  useStore.setState((s) => ({
    doc: s.doc ?? doc,
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
  const layout = nodes.filter((n) => closing.has(n.id) && (n.kind === 'sticky' || n.kind === 'whiteboard' || n.kind === 'group'))
  const pages = nodes.filter((n) => closing.has(n.id) && n.kind === 'browser').map((n) => n.id)
  if (pages.length) dispatch({ op: 'removeNodes', ids: pages, at: Date.now() })
  if (layout.length) {
    const kinds = new Set(layout.map((n) => n.kind))
    const label = kinds.size > 1 ? 'delete' : kinds.has('sticky') ? 'delete note' : kinds.has('whiteboard') ? 'delete whiteboard' : 'remove group'
    undoable(label, [{ op: 'removeNodes', ids: layout.map((n) => n.id), at: Date.now() }])
  }
  if (sessions.length) dispatch({ op: 'removeNodes', ids: sessions, at: Date.now() })
}

export async function restartNode(id: string): Promise<void> {
  noteRunProblem(id, await bridge.restartNode(id))
  useStore.setState((s) => ({ epochs: { ...s.epochs, [id]: (s.epochs[id] ?? 0) + 1 } }))
}

/** Opens and starts a terminal in a folder, just to the right of another window. */
export function openTerminalBeside(besideId: string, cwd: string): string | null {
  const doc = useStore.getState().doc
  const beside = doc?.nodes.find((n) => n.id === besideId)
  if (!doc || !beside) return null
  const at = absolutePosition(doc, beside)
  const node = newTerminal({ at: { x: at.x + beside.width + 24, y: at.y }, group: null, doc }, crypto.randomUUID(), { cwd })
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
