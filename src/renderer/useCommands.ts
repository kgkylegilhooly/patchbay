import { useReactFlow } from '@xyflow/react'
import { useMemo, useRef } from 'react'
import { inActiveProject, isSessionNode, type CanvasNode, type GroupNode } from '../shared/model'
import { bridge } from './bridge'
import type { FlowEdge, FlowNode } from './flowMapping'
import type { Commands, Point } from './menus'
import type { LaunchChoice } from './LaunchForm'
import { absolutePosition, groupMembers, newBrowser, newClaude, newGroup, newLaunchRun, newRun, newSsh, newSticky, newTerminal, newTrigger, newWhiteboard, SIZES } from './newNodes'
import type { TriggerFields } from './TriggerForm'
import { nearestInDirection } from './nodeNav'
import { steppedFontSize, type Prefs, type TogglePref } from './prefs'
import { closeNodes, dispatch, nameWithAi, noteRunProblem, patchNode, redo, refreshWindow, restartNode, toggleMaximize, undo, undoable, useStore } from './store'
import { TEAM_LEAD_TITLE, teamLeadPrompt } from './teamPrompt'
import { moveBetweenPanes, revealInFocus, showInFocus, toggleFocus } from './focusState'
import { focusedTerminal, focusedTerminalId, terminalActions } from './terminalRegistry'

export type NewForm = { kind: 'claude' | 'codex' | 'terminal' | 'ssh' | 'run' | 'team' | 'run-config' | 'trigger' | 'arm'; at?: Point; groupId?: string; editId?: string } | null

/** The window that window actions mean: one filling the canvas, the terminal in use, or a single selected session. */
export function currentWindow(selected: string[]): string | null {
  const s = useStore.getState()
  if (s.maximized) return s.maximized
  const focused = focusedTerminalId()
  if (focused) return focused
  const node = selected.length === 1 ? s.doc?.nodes.find((n) => n.id === selected[0]) : undefined
  return isSessionNode(node) ? node.id : null
}

interface Options {
  selectedRef: React.RefObject<string[]>
  prefsRef: React.RefObject<Prefs>
  setNodes: React.Dispatch<React.SetStateAction<FlowNode[]>>
  setForm: (form: NewForm) => void
  setPref: (key: TogglePref) => void
  toggleRecent: () => void
  openSettings: () => void
  openPalette: () => void
  setProjectFormOpen: (open: boolean) => void
}

/** Every action the menu bar, right-click menus and dock can take. */
export function useCommands({ selectedRef, prefsRef, setNodes, setForm, setPref, toggleRecent, openSettings, openPalette, setProjectFormOpen }: Options): {
  commands: Commands
  openFromForm: (form: NonNullable<NewForm>, fields: { cwd: string; text?: string }) => void
  openLaunch: (form: NonNullable<NewForm>, choice: LaunchChoice) => void
  openSsh: (form: NonNullable<NewForm>, fields: { host: string; home: string }) => void
  saveTrigger: (form: NonNullable<NewForm>, fields: TriggerFields) => void
  defaultFolder: (groupId?: string) => string
  fitAll: () => void
} {
  const flow = useReactFlow<FlowNode, FlowEdge>()
  const lastFolder = useRef('')
  const opened = useRef(0)

  return useMemo(() => {
    const doc = () => useStore.getState().doc!

    const groupFor = (groupId?: string): GroupNode | null => {
      const selected = selectedRef.current
      const id = groupId ?? (selected.length === 1 ? selected[0] : undefined)
      const node = id ? doc().nodes.find((n) => n.id === id) : undefined
      return node?.kind === 'group' ? node : null
    }

    /** A new node's default folder: its group's worktree, the selected node's, or the last one used. */
    const defaultFolder = (groupId?: string): string => {
      const group = groupFor(groupId)
      if (group?.worktree) return group.worktree.path
      const node = doc().nodes.find((n) => selectedRef.current.includes(n.id))
      if (isSessionNode(node)) return node.cwd
      return doc().projects.find((p) => p.id === doc().activeProjectId)?.folder || lastFolder.current
    }

    const place = (at?: Point, groupId?: string) => {
      const group = groupFor(groupId)
      if (at) return { at: flow.screenToFlowPosition(at), group, doc: doc() }
      const bounds = document.querySelector('.react-flow')?.getBoundingClientRect()
      const center = flow.screenToFlowPosition({
        x: (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2 - 200,
        y: (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2 - 150
      })
      // Each new node steps down and across, so a run of them doesn't stack exactly.
      const step = (opened.current++ % 6) * 28
      return { at: { x: center.x + step, y: center.y + step }, group, doc: doc() }
    }

    const open = (node: CanvasNode): void => {
      dispatch({ op: 'addNode', node })
      if (isSessionNode(node)) void bridge.startNode(node.id).then((r) => noteRunProblem(node.id, r))
    }

    /** Fits everything into the part of the canvas the sidebar and dock don't cover. */
    const fitAll = (): void => {
      const left = prefsRef.current.sidebar ? '330px' : '24px'
      void flow.fitView({ padding: { top: '24px', left, right: '24px', bottom: '84px' }, duration: 220 })
    }

    const target = (nodeId?: string) => (nodeId ? terminalActions(nodeId) : focusedTerminal())

    /** Brings a node into view and gives its terminal the keyboard. A node in another project has to be drawn first. */
    const center = (id: string): void => {
      const go = (): void => {
        void flow.fitView({ nodes: [{ id }], padding: 0.2, maxZoom: 1, duration: 260 })
        terminalActions(id)?.focus()
      }
      if (flow.getNode(id)) go()
      else setTimeout(go, 300)
    }

    const onWindow = (nodeId: string | undefined, act: (id: string) => void): void => {
      const id = nodeId ?? currentWindow(selectedRef.current)
      if (id) act(id)
    }

    /** Saves where the view is now, because the delayed save from panning may not have run yet. */
    const keepView = (): void => dispatch({ op: 'setViewport', viewport: flow.getViewport() })

    const commands: Commands = {
      newProject: () => setProjectFormOpen(true),
      createProject: ({ name, folder }) => {
        keepView()
        dispatch({ op: 'addProject', project: { id: crypto.randomUUID(), name, folder, viewport: { x: 0, y: 0, zoom: 1 } } })
      },
      switchProject: (id) => {
        keepView()
        dispatch({ op: 'switchProject', id })
      },
      setProjectName: (id, name) => dispatch({ op: 'patchProject', id, patch: { name } }),
      chooseProjectFolder: (id) => {
        void bridge.pickFolder().then((folder) => folder && dispatch({ op: 'patchProject', id, patch: { folder } }))
      },
      closeProject: (id) => {
        keepView()
        dispatch({ op: 'closeProject', id: id ?? doc().activeProjectId, at: Date.now() })
      },
      reopenProject: (id) => {
        keepView()
        dispatch({ op: 'switchProject', id })
      },
      deleteProject: (id) => dispatch({ op: 'removeProject', id, at: Date.now() }),
      revealNode: (id) => {
        const node = doc().nodes.find((n) => n.id === id)
        if (!node) return
        bridge.markSeen(id)
        // The focus view covers the canvas, so the window comes to a pane there instead.
        if (useStore.getState().focus && isSessionNode(node) && inActiveProject(doc(), node)) return revealInFocus(id)
        // Going to a session means seeing it, so the board steps aside.
        useStore.setState({ maximized: null, boardOpen: false })
        if (node.projectId && node.projectId !== doc().activeProjectId) {
          keepView()
          dispatch({ op: 'switchProject', id: node.projectId })
        }
        center(id)
      },
      newTerminal: (at, groupId) => open(newTerminal(place(at, groupId), crypto.randomUUID(), { cwd: defaultFolder(groupId) })),
      newTerminalForm: (at, groupId) => setForm({ kind: 'terminal', at, groupId }),
      newSshForm: (at, groupId) => setForm({ kind: 'ssh', at, groupId }),
      newClaudeForm: (at, groupId) => setForm({ kind: 'claude', at, groupId }),
      newCodexForm: (at, groupId) => setForm({ kind: 'codex', at, groupId }),
      newRunForm: (at, groupId) => setForm({ kind: 'run', at, groupId }),
      newBrowser: (at, groupId) => open(newBrowser(place(at, groupId), crypto.randomUUID())),
      setBrowserHeld: (id, held) => patchNode(id, { held }),
      reloadBrowser: (id) => void bridge.browserStep(id, 'reload'),
      spawnTeamForm: (at) => setForm({ kind: 'team', at }),
      editRunCommand: (id) => setForm({ kind: 'run', editId: id }),
      newRunConfigForm: (at, groupId) => setForm({ kind: 'run-config', at, groupId }),
      newTriggerForm: (at) => setForm({ kind: 'trigger', at }),
      editTrigger: (id) => setForm({ kind: 'trigger', editId: id }),
      armTrigger: (id) => setForm({ kind: 'arm', editId: id }),
      disarmTrigger: (id) => void bridge.disarmTrigger(id),
      runTriggerNow: (id) => void bridge.runTriggerNow(id),
      newSticky: (at) => undoable('add note', [{ op: 'addNode', node: newSticky(place(at), crypto.randomUUID()) }]),
      // Not undoable: redoing it would bring the board back empty, losing what was drawn since. Deleting it is undoable.
      newWhiteboard: (at) => void dispatch({ op: 'addNode', node: newWhiteboard(place(at), crypto.randomUUID()) }),
      group: (at) => {
        const members = groupMembers(doc(), selectedRef.current)
        const id = crypto.randomUUID()
        undoable('group', [
          { op: 'addNode', node: newGroup(doc(), place(at).at, id, members) },
          ...(members.length ? [{ op: 'setParent' as const, ids: members.map((m) => m.id), parentId: id }] : [])
        ])
      },
      closeSelected: () => closeNodes(selectedRef.current),
      closeNode: (id) => closeNodes([id]),
      renameNode: (id) => useStore.setState({ renaming: id }),
      restartNode: (id) => void restartNode(id),
      toggleRecent,
      quit: () => void bridge.quitApp(),
      stopAllAndQuit: () => void bridge.stopAllAndQuit(),
      copy: (nodeId) => target(nodeId)?.copy(),
      paste: (nodeId) => target(nodeId)?.paste(),
      find: (nodeId) => target(nodeId)?.find(),
      refreshWindow: (nodeId) => onWindow(nodeId, refreshWindow),
      nameWithAi: (nodeId) => onWindow(nodeId, (id) => void nameWithAi(id)),
      toggleMaximize: (nodeId) => onWindow(nodeId, toggleMaximize),
      stepFont: (step, nodeId) =>
        onWindow(nodeId, (id) => {
          const own = doc().nodes.find((n) => n.id === id)?.fontSize
          patchNode(id, { fontSize: steppedFontSize(own, prefsRef.current.fontSize, step) })
        }),
      resetFont: (nodeId) => onWindow(nodeId, (id) => patchNode(id, { fontSize: undefined })),
      moveFocus: (direction) => {
        if (useStore.getState().focus) return moveBetweenPanes(focusedTerminalId(), direction)
        const here = doc().nodes.filter((n) => isSessionNode(n) && inActiveProject(doc(), n))
        const rects = here.map((n) => ({ id: n.id, width: n.width, height: n.height, ...absolutePosition(doc(), n) }))
        const next = nearestInDirection(rects, currentWindow(selectedRef.current), direction)
        if (!next) return
        const rect = rects.find((r) => r.id === next)!
        setNodes((nodes) => nodes.map((n) => (n.selected === (n.id === next) ? n : { ...n, selected: n.id === next })))
        useStore.setState((s) => ({ maximized: s.maximized && next }))
        void flow.setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, { zoom: flow.getZoom(), duration: 200 })
        terminalActions(next)?.focus()
      },
      undo,
      redo,
      selectAll: () => setNodes((nodes) => nodes.map((n) => ({ ...n, selected: true }))),
      zoomIn: () => void flow.zoomIn({ duration: 160 }),
      zoomOut: () => void flow.zoomOut({ duration: 160 }),
      zoomReset: () => void flow.zoomTo(1, { duration: 160 }),
      fitView: fitAll,
      tidy: (ids) => {
        const top = ids ?? doc().nodes.filter((n) => n.parentId === null && inActiveProject(doc(), n)).map((n) => n.id)
        if (top.length === 0) return
        undoable('tidy', [{ op: 'arrange', ids: top, layout: 'grid' }])
        setTimeout(fitAll, 120)
      },
      togglePref: setPref,
      openSettings,
      openPalette,
      toggleGit: (folder) => {
        if (folder) useStore.setState({ gitOpen: true, gitFolder: folder })
        else useStore.setState((s) => ({ gitOpen: !s.gitOpen, gitFolder: null }))
      },
      toggleBoard: () => useStore.setState((s) => ({ boardOpen: !s.boardOpen, maximized: null, focus: null })),
      toggleFocus: (nodeId) => (nodeId ? showInFocus(nodeId) : toggleFocus(selectedRef.current))
    }

    const openFromForm = (form: NonNullable<NewForm>, fields: { cwd: string; text?: string }): void => {
      lastFolder.current = fields.cwd || lastFolder.current
      if (form.editId) {
        // Applies from the next run. Whatever's running now keeps running.
        dispatch({ op: 'patchNode', id: form.editId, patch: { command: fields.text ?? '', cwd: fields.cwd } })
        return
      }
      if (form.kind === 'team') {
        const p = place(form.at)
        // The lead is the default agent from Settings. Placed now, so it lands where the form was.
        void bridge.getSettings().then((settings) => {
          const agent = settings.defaultAgent === 'codex' ? 'codex' : 'claude'
          const lead = newClaude(p, crypto.randomUUID(), { cwd: fields.cwd, prompt: teamLeadPrompt(fields.text ?? ''), agent })
          open({ ...lead, title: TEAM_LEAD_TITLE })
        })
        return
      }
      if (form.kind === 'run') {
        open(newRun(place(form.at, form.groupId), crypto.randomUUID(), { cwd: fields.cwd, command: fields.text ?? '' }))
        return
      }
      const id = crypto.randomUUID()
      const p = place(form.at, form.groupId)
      open(
        form.kind === 'claude' || form.kind === 'codex'
          ? newClaude(p, id, { cwd: fields.cwd, prompt: fields.text, agent: form.kind })
          : newTerminal(p, id, { cwd: fields.cwd, command: fields.text })
      )
    }

    const openSsh = (form: NonNullable<NewForm>, fields: { host: string; home: string }): void => {
      open(newSsh(place(form.at, form.groupId), crypto.randomUUID(), fields))
    }

    /** One run node, or for a compound a group holding one per configuration, each with its own state. Running is this click. */
    const openLaunch = (form: NonNullable<NewForm>, { folder, item }: LaunchChoice): void => {
      lastFolder.current = folder
      if (item.kind === 'config') {
        open(newLaunchRun(place(form.at, form.groupId), crypto.randomUUID(), { folder, name: item.name }))
        return
      }
      const at = place(form.at).at
      const gap = 24
      const group: GroupNode = {
        id: crypto.randomUUID(),
        kind: 'group',
        title: item.name,
        x: at.x,
        y: at.y,
        width: gap + item.members.length * (SIZES.run.width + gap),
        height: 64 + SIZES.run.height + gap,
        parentId: null,
        worktree: null
      }
      dispatch({ op: 'addNode', node: group })
      item.members.forEach((name, i) => {
        const member = newLaunchRun({ at, group, doc: doc() }, crypto.randomUUID(), { folder, name })
        open({ ...member, x: gap + i * (SIZES.run.width + gap), y: 64 })
      })
    }

    const saveTrigger = (form: NonNullable<NewForm>, fields: TriggerFields): void => {
      // Changing what it sends disarms it. That's done in the reducer, so no route around it exists.
      if (form.editId) dispatch({ op: 'patchNode', id: form.editId, patch: fields })
      else dispatch({ op: 'addNode', node: newTrigger(place(form.at), crypto.randomUUID(), fields) })
    }

    return { commands, openFromForm, openLaunch, openSsh, saveTrigger, defaultFolder, fitAll }
  }, [flow, prefsRef, selectedRef, setForm, setNodes, setPref, toggleRecent, openSettings, openPalette, setProjectFormOpen])
}
