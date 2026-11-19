import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  MiniMap,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeChange,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isTriggerTarget, targetsFor } from '../core/trigger/arming'
import { isProjectOpen, type CanvasDoc, type RunNode as RunNodeModel, type TriggerNode as TriggerNodeModel } from '../shared/model'
import { SshForm } from './SshForm'
import { LaunchForm } from './LaunchForm'
import { TriggerNode } from './nodes/TriggerNode'
import { ArmReview, TriggerForm } from './TriggerForm'
import { ACTIONS, actionReady, worksOverBoard } from './actions'
import { Board } from './Board'
import { bridge } from './bridge'
import { setCableMotion } from './cableMotion'
import { GitPanel } from './GitPanel'
import { CommandPalette } from './CommandPalette'
import { Dock } from './Dock'
import { dragOps } from './dragOps'
import { type FlowEdge, type FlowNode, mergeFlowNodes, toFlow } from './flowMapping'
import { shareEdges } from './docShare'
import { actionForKey, appTakesKey, isOverTerminal, keyFocusOf, keyFromEvent } from './keys'
import { FocusView } from './FocusView'
import { ContextMenu } from './Menu'
import { canvasMenu, nodeMenu, type MenuEntry, type MenuState, type Point } from './menus'
import { NewProjectForm } from './NewProjectForm'
import { NewSessionForm } from './NewSessionForm'
import { BrowserNode } from './nodes/BrowserNode'
import { CableEdge } from './nodes/CableEdge'
import { ClaudeNode } from './nodes/ClaudeNode'
import { GroupNode } from './nodes/GroupNode'
import { RunNode } from './nodes/RunNode'
import { StickyNode } from './nodes/StickyNode'
import { WhiteboardNode } from './nodes/WhiteboardNode'
import { TerminalNode } from './nodes/TerminalNode'
import { noteRecent } from './palette'
import { clampFontSize, loadPrefs, savePrefs, type Prefs, type TogglePref } from './prefs'
import { useViewAreaReport } from './viewArea'
import { RecentPanel } from './RecentPanel'
import { SearchLayer } from './SearchLayer'
import { ReviewInboxLayer } from './ReviewInbox'
import { RecipeLayer } from './RecipeLayer'
import { CompareLayer } from './CompareLayer'
import { SubagentLayer } from './subagents/SubagentLayer'
import { FileNode } from './nodes/FileNode'
import { dropFileOnWindow, FileShelfLayer } from './FileShelf'
import { HeaderZoomWatcher } from './useHeaderZoom'
import { SettingsPage } from './SettingsPage'
import { Sidebar } from './Sidebar'
import { dispatch, undoable, undoState, useStore } from './store'
import { focusedTerminal, terminalActions } from './terminalRegistry'
import { TopBar } from './TopBar'
import { currentWindow, useCommands, type NewForm } from './useCommands'
import type { UsageMode } from './usageView'
import './styles.css'

const nodeTypes = { terminal: TerminalNode, claude: ClaudeNode, run: RunNode, sticky: StickyNode, whiteboard: WhiteboardNode, group: GroupNode, browser: BrowserNode, trigger: TriggerNode, file: FileNode }
const edgeTypes = { cable: CableEdge }

const STATUS_COLORS: Record<string, string> = {
  working: '#ffb938',
  idle: '#62dc8a',
  'needs-you': '#ff5b4e',
  queued: '#8fb4ff',
  starting: '#8fb4ff',
  exited: '#6d7790',
  unknown: '#a3abbd'
}

function miniMapColor(node: FlowNode): string {
  if (node.data.node.kind === 'group') return 'transparent'
  if (node.data.node.kind === 'sticky') return '#a89a2b'
  if (node.data.node.kind === 'whiteboard') return '#d8d8d2'
  if (node.data.node.kind === 'trigger') return '#e7b53f'
  return node.data.status ? (STATUS_COLORS[node.data.status] ?? '#a3abbd') : '#a3abbd'
}

function miniMapStroke(node: FlowNode): string {
  return node.data.node.kind === 'group' ? (node.data.node.color ?? '#49c2c9') : 'transparent'
}

function editedRun(doc: CanvasDoc, id?: string): RunNodeModel | undefined {
  const node = doc.nodes.find((n) => n.id === id)
  return node?.kind === 'run' ? node : undefined
}

function editedTrigger(doc: CanvasDoc, id?: string): TriggerNodeModel | undefined {
  const node = doc.nodes.find((n) => n.id === id)
  return node?.kind === 'trigger' ? node : undefined
}

function Canvas(): React.JSX.Element | null {
  const doc = useStore((s) => s.doc)
  const statuses = useStore((s) => s.statuses)
  const gitOpen = useStore((s) => s.gitOpen)
  const boardOpen = useStore((s) => s.boardOpen)
  const flow = useReactFlow<FlowNode, FlowEdge>()
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<FlowEdge[]>([])
  const [recentOpen, setRecentOpen] = useState(false)
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const initialViewport = useRef<Viewport | null>(null)
  if (doc && !initialViewport.current) initialViewport.current = doc.viewport

  // Before the browser paints, so a change shows in the frame it arrived in rather than the one after.
  useLayoutEffect(() => {
    if (!doc) return
    const mapped = toFlow(doc, statuses)
    setNodes((prev) => mergeFlowNodes(prev, mapped.nodes))
    setEdges((prev) => shareEdges(prev, mapped.edges))
  }, [doc, statuses])

  const selected = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes])
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const [prefs, setPrefs] = useState(loadPrefs)
  useViewAreaReport(prefs.sidebar)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const setPref = useCallback((key: TogglePref) => {
    setPrefs((p) => {
      const next = { ...p, [key]: !p[key] }
      savePrefs(next)
      return next
    })
  }, [])
  const setFontSize = useCallback((size: number) => {
    setPrefs((p) => {
      const next = { ...p, fontSize: clampFontSize(size) }
      savePrefs(next)
      return next
    })
  }, [])
  useEffect(() => useStore.setState({ terminalFontSize: prefs.fontSize }), [prefs.fontSize])
  useEffect(() => useStore.setState({ terminalLook: prefs.terminal }), [prefs.terminal])
  const setUsageMode = useCallback((usageMode: UsageMode) => {
    setPrefs((p) => {
      const next = { ...p, usageMode }
      savePrefs(next)
      return next
    })
    useStore.setState({ usageMode })
  }, [])

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      savePrefs(next)
      return next
    })
  }, [])
  useEffect(() => useStore.setState({ keyOverrides: prefs.keys }), [prefs.keys])

  const [paletteOpen, setPaletteOpen] = useState(false)
  // Where the keyboard goes back to when the palette closes, so a terminal in use stays in use.
  const beforePalette = useRef<HTMLElement | null>(null)
  const togglePalette = useCallback(() => {
    setPaletteOpen((open) => {
      if (!open) beforePalette.current = document.activeElement as HTMLElement | null
      return !open
    })
  }, [])
  const closePalette = useCallback(() => {
    setPaletteOpen(false)
    beforePalette.current?.focus?.()
    beforePalette.current = null
  }, [])

  const [form, setForm] = useState<NewForm>(null)
  const [menu, setMenu] = useState<{ at: Point; entries: MenuEntry[]; label: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const toggleRecent = useCallback(() => setRecentOpen((o) => !o), [])
  const closeSidebar = useCallback(() => setPref('sidebar'), [setPref])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const [projectFormOpen, setProjectFormOpen] = useState(false)
  const { commands, openFromForm, openLaunch, openSsh, saveTrigger, defaultFolder, terminalFolder } = useCommands({ selectedRef, prefsRef, setNodes, setForm, setPref, toggleRecent, openSettings, openPalette: togglePalette, setProjectFormOpen })

  // A trigger's own Edit and Arm buttons.
  const triggerAsk = useStore((s) => s.triggerAsk)
  useEffect(() => {
    if (!triggerAsk) return
    setForm({ kind: triggerAsk.kind === 'arm' ? 'arm' : 'trigger', editId: triggerAsk.id })
    useStore.setState({ triggerAsk: null })
  }, [triggerAsk])

  // Each project keeps its own view. Nothing waiting to save may land on the project just shown.
  const activeProjectId = doc?.activeProjectId
  const shownProject = useRef(activeProjectId)
  useEffect(() => {
    if (shownProject.current === activeProjectId) return
    shownProject.current = activeProjectId
    clearTimeout(viewportTimer.current)
    const viewport = useStore.getState().doc?.viewport
    if (viewport) void flow.setViewport(viewport)
  }, [activeProjectId, flow])

  // Reads only refs and the store when called, so it can stay one function, which lets the panels it's given skip redraws.
  const menuState = useCallback((): MenuState => {
    const terminal = focusedTerminal()
    const current = useStore.getState().doc
    const windowId = currentWindow(selectedRef.current)
    const windowKind = current?.nodes.find((n) => n.id === windowId)?.kind
    return {
      selectedCount: selectedRef.current.length,
      canCopy: !!terminal?.hasSelection(),
      canFind: !!terminal,
      sidebar: prefsRef.current.sidebar,
      minimap: prefsRef.current.minimap,
      legend: prefsRef.current.legend,
      snap: prefsRef.current.snap,
      ...undoState(),
      hasWindow: windowId !== null,
      canName: windowKind === 'terminal' || windowKind === 'claude',
      canCloseProject: (current?.projects.filter(isProjectOpen).length ?? 0) > 1,
      closedProjects: current?.projects.filter((p) => !isProjectOpen(p)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
      gitPanel: useStore.getState().gitOpen,
      board: useStore.getState().boardOpen,
      focus: !!useStore.getState().focus
    }
  }, [])
  const keyboard = useRef({ commands, menuState })
  keyboard.current = { commands, menuState }

  // One listener for every shortcut, ahead of a focused terminal. appTakesKey decides what the terminal keeps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useStore.getState()
      if (s.capturingKey) return
      const focus = keyFocusOf(e.target as Element | null)
      // A focused terminal keeps Esc, which is how Claude is interrupted. Anything open on top goes first.
      if (e.key === 'Escape' && s.maximized && focus === 'canvas' && !document.querySelector('.menu-panel, .palette, .pop, .settings')) {
        e.preventDefault()
        e.stopPropagation()
        useStore.setState({ maximized: null })
        return
      }
      const key = keyFromEvent(e)
      if (!key) return
      const overrides = prefsRef.current.keys
      const action = actionForKey(key, ACTIONS, overrides)
      if (!action || !appTakesKey(key, focus, isOverTerminal(action, overrides))) return
      // The board covers the canvas, so a canvas key is left alone, for the board's own fields to use.
      if (s.boardOpen && !worksOverBoard(action)) return
      // With no terminal to paste into, Ctrl+V is left to the page, so a selected whiteboard can take a picture.
      if (action.id === 'paste' && !actionReady(action, keyboard.current.menuState())) return
      e.preventDefault()
      e.stopPropagation()
      // Holding a key down steps through sizes and windows, but shouldn't open a window per repeat.
      if (e.repeat && !/^(font|zoom|focus)-/.test(action.id)) return
      const { commands: c, menuState: state } = keyboard.current
      if (actionReady(action, state())) action.run(c)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // A window filling the canvas can't outlast being closed, or its project going off screen.
  useEffect(() => {
    const id = useStore.getState().maximized
    if (!id || !doc) return
    const node = doc.nodes.find((n) => n.id === id)
    if (!node || node.projectId !== doc.activeProjectId) useStore.setState({ maximized: null })
  }, [doc])

  // A drag that passes over a page would otherwise be taken by it, because it's a separate process. Any press outside a
  // page leaves every page out of pointer events until it ends. A press inside a page never gets here, and needs no help.
  useEffect(() => {
    const down = (): void => document.body.classList.add('pb-pressing')
    const up = (): void => document.body.classList.remove('pb-pressing')
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('blur', up)
    }
  }, [])

  const onPaneMenu = (e: MouseEvent | React.MouseEvent): void => {
    e.preventDefault()
    const at = { x: e.clientX, y: e.clientY }
    setMenu({ at, entries: canvasMenu(commands, menuState(), at), label: 'Canvas' })
  }

  const onNodeMenu = (e: React.MouseEvent, flowNode: FlowNode): void => {
    e.preventDefault()
    const node = flowNode.data.node
    const status = useStore.getState().statuses[node.id] ?? null
    const canRestart = status === 'exited' || !!useStore.getState().errors[node.id]
    const at = { x: e.clientX, y: e.clientY }
    const canCopy = !!terminalActions(node.id)?.hasSelection()
    setMenu({ at, entries: nodeMenu(commands, node, status, { at, canCopy, canRestart }), label: node.title })
  }

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((prev) => applyEdgeChanges(changes, prev))
  }, [])

  const finishDrag = useCallback(
    (dragged: FlowNode[]) => {
      const current = useStore.getState().doc
      if (!current) return
      const moved = dragged.map((n) => ({
        id: n.id,
        rel: n.position,
        abs: flow.getInternalNode(n.id)?.internals.positionAbsolute ?? n.position
      }))
      undoable('move', dragOps(current, moved))
    },
    [flow]
  )

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return
    const nodes = useStore.getState().doc?.nodes ?? []
    const source = nodes.find((n) => n.id === c.source)
    if (source?.kind === 'trigger') {
      // Choosing what a trigger sends to. Any change disarms it.
      if (isTriggerTarget(nodes.find((n) => n.id === c.target))) dispatch({ op: 'patchNode', id: source.id, patch: { targetId: c.target } })
      return
    }
    dispatch({ op: 'addEdge', edge: { id: crypto.randomUUID(), from: c.source, to: c.target, kind: 'link' } })
  }, [])

  useEffect(
    () =>
      bridge.onCenterNode((id) => {
        const center = (): void => void flow.fitView({ nodes: [{ id }], padding: 0.2, maxZoom: 1, duration: 260 })
        // A node in another project only exists on screen once its project has been drawn.
        if (flow.getNode(id)) center()
        else setTimeout(center, 300)
      }),
    [flow]
  )

  const onMove = useCallback((_e: unknown, viewport: Viewport) => {
    clearTimeout(viewportTimer.current)
    viewportTimer.current = setTimeout(() => dispatch({ op: 'setViewport', viewport }), 300)
  }, [])

  const stage = useRef<HTMLElement>(null)
  const onMoveStart = useCallback((_e: unknown, viewport: Viewport) => setCableMotion(stage.current, { moving: true, zoom: viewport.zoom }), [])
  const onMoveEnd = useCallback((_e: unknown, viewport: Viewport) => setCableMotion(stage.current, { moving: false, zoom: viewport.zoom }), [])
  // A click on the map goes to that spot at the same zoom. A drag still pans.
  const onMapClick = useCallback((_e: unknown, at: { x: number; y: number }) => void flow.setCenter(at.x, at.y, { zoom: flow.getZoom(), duration: 200 }), [flow])
  // A canvas saved zoomed far out opens that way, with no move to report it.
  const ready = !!doc
  useEffect(() => {
    if (ready) setCableMotion(stage.current, { moving: false, zoom: flow.getZoom() })
  }, [ready, activeProjectId, flow])

  if (!doc || !initialViewport.current) return null

  return (
    <div className="app">
      <TopBar commands={commands} state={menuState} />
      <main className="stage" ref={stage}>
        <ReactFlow<FlowNode, FlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="dark"
          defaultViewport={initialViewport.current}
          minZoom={0.1}
          maxZoom={2}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={(e, n, dragged) => (dragged.length === 1 && dropFileOnWindow(e, n, (id, position) => flow.updateNode(id, { position }))) || finishDrag(dragged)}
          onSelectionDragStop={(_e, dragged) => finishDrag(dragged)}
          onConnect={onConnect}
          onMove={onMove}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          onPaneClick={() => {
            if (prefsRef.current.sidebar && !prefsRef.current.sidebarPinned) setPref('sidebar')
          }}
          onPaneContextMenu={onPaneMenu}
          onSelectionContextMenu={onPaneMenu}
          onNodeContextMenu={onNodeMenu}
          onNodeClick={(_e, node) => bridge.markSeen(node.id)}
          onlyRenderVisibleElements={false}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          snapToGrid={prefs.snap}
          zoomOnScroll={prefs.wheel === 'zoom'}
          panOnScroll={prefs.wheel === 'pan'}
          snapGrid={[24, 24]}
          attributionPosition="top-right"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--hole)" />
          <SubagentLayer />
          {prefs.minimap && (
            <MiniMap<FlowNode>
              pannable
              zoomable
              onClick={onMapClick}
              nodeColor={miniMapColor}
              nodeStrokeColor={miniMapStroke}
              nodeStrokeWidth={6}
              nodeBorderRadius={0}
              maskColor="rgb(14 14 16 / 0.68)"
              ariaLabel="Map of the canvas"
            />
          )}
        </ReactFlow>
        {nodes.length === 0 && <p className="stage-empty">Right-click the canvas to open a terminal, a Claude session or a Codex session.</p>}
        {prefs.legend && (
          <ul className="legend" aria-label="What the links mean">
            <li className="legend-opened">Opened</li>
            <li className="legend-link">Linked</li>
            <li className="legend-after">Starts after</li>
            <li className="legend-trigger">Trigger</li>
            <li className="legend-note">Dots and arrowheads travel the way a one-way link runs. Linked works both ways, so it stays still.</li>
          </ul>
        )}
        {prefs.sidebar && (
          <Sidebar commands={commands} prefs={prefs} onPrefs={updatePrefs} onClose={closeSidebar} />
        )}
        <Dock commands={commands} sidebar={prefs.sidebar} recent={recentOpen} groupLabel={selected.length ? 'Group selection' : 'New group'} />
        {form?.kind === 'run-config' && (
          <LaunchForm
            initialFolder={defaultFolder(form.groupId)}
            onCancel={() => setForm(null)}
            onRun={(choice) => {
              openLaunch(form, choice)
              setForm(null)
            }}
          />
        )}
        {form?.kind === 'ssh' && (
          <SshForm
            onCancel={() => setForm(null)}
            onOpen={(fields) => {
              openSsh(form, fields)
              setForm(null)
            }}
          />
        )}
        {form?.kind === 'trigger' && (
          <TriggerForm
            key={form.editId ?? 'new'}
            editing={editedTrigger(doc, form.editId)}
            targets={targetsFor(doc, editedTrigger(doc, form.editId) ?? { projectId: doc.activeProjectId })}
            onCancel={() => setForm(null)}
            onSave={(fields) => {
              saveTrigger(form, fields)
              setForm(null)
            }}
          />
        )}
        {form?.kind === 'arm' && editedTrigger(doc, form.editId) && (
          <ArmReview
            key={form.editId}
            node={editedTrigger(doc, form.editId)!}
            target={targetsFor(doc, editedTrigger(doc, form.editId)!).find((t) => t.id === editedTrigger(doc, form.editId)!.targetId)}
            onClose={() => setForm(null)}
          />
        )}
        {form && form.kind !== 'run-config' && form.kind !== 'ssh' && form.kind !== 'trigger' && form.kind !== 'arm' && (
          <NewSessionForm
            kind={form.kind}
            initialFolder={editedRun(doc, form.editId)?.cwd ?? defaultFolder(form.groupId)}
            initialCommand={editedRun(doc, form.editId)?.command}
            folderFor={form.kind === 'terminal' ? (profile) => terminalFolder(form.groupId, profile) : undefined}
            editing={!!form.editId}
            onCancel={() => setForm(null)}
            onOpen={(fields) => {
              openFromForm(form, fields)
              setForm(null)
            }}
          />
        )}
        {projectFormOpen && (
          <NewProjectForm
            onCancel={() => setProjectFormOpen(false)}
            onCreate={(fields) => {
              commands.createProject(fields)
              setProjectFormOpen(false)
            }}
          />
        )}
        {settingsOpen && <SettingsPage prefs={prefs} onToggle={setPref} onFontSize={setFontSize} onUsageMode={setUsageMode} onKeys={(keys) => updatePrefs({ keys })} onPrefs={updatePrefs} onClose={() => setSettingsOpen(false)} />}
        {paletteOpen && <CommandPalette commands={commands} state={menuState()} recent={prefs.recentActions} onRan={(id) => updatePrefs({ recentActions: noteRecent(prefsRef.current.recentActions, id) })} onClose={closePalette} />}
        {recentOpen && <RecentPanel onClose={() => setRecentOpen(false)} />}
        <SearchLayer />
        <RecipeLayer selected={selected} />
        <CompareLayer />
        <HeaderZoomWatcher />
        <FocusView />
        {boardOpen && <Board commands={commands} />}
        {gitOpen && <GitPanel selected={selected} />}
        <ReviewInboxLayer />
        <FileShelfLayer />
      </main>
      {menu && <ContextMenu at={menu.at} entries={menu.entries} label={menu.label} onClose={closeMenu} />}
    </div>
  )
}

export function App(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
