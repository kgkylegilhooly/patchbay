import { useReactFlow } from '@xyflow/react'
import { useMemo, useRef } from 'react'
import { inActiveProject, isSessionNode, type CanvasNode, type GroupNode } from '../shared/model'
import { bridge } from './bridge'
import type { FlowEdge, FlowNode } from './flowMapping'
import type { Commands, Point } from './menus'
import type { LaunchChoice } from './LaunchForm'
import { pickedProfile, profileFolder, terminalFolderFor } from './terminalProfilesUi'
import { absolutePosition, groupMembers, newBrowser, newClaude, newGroup, newLaunchRun, newRun, newSsh, newSticky, newTerminal, newTrigger, newWhiteboard, placed, SIZES, type Place } from './newNodes'
import type { Rect } from '../core/canvas/place'
import { visibleArea } from './viewArea'
import { safePadding } from './safeArea'
import { centredIn } from '../core/canvas/safeArea'
import { panToShow } from '../core/canvas/tidy'
import { openTidy } from './tidyUi'
import type { TriggerFields } from './TriggerForm'
import { nearestInDirection } from './nodeNav'
import { steppedFontSize, type Prefs, type TogglePref } from './prefs'
import { stepProjectTab } from './projectActions'
import { openProjects } from './projectsUi'
import { closeNodes, dispatch, nameWithAi, noteRunProblem, patchNode, redo, refreshWindow, restartNode, toggleMaximize, undo, undoable, useStore } from './store'
import { TEAM_LEAD_TITLE, teamLeadPrompt } from './teamPrompt'
import { defaultAgentOf } from '../shared/agents'
import { moveBetweenPanes, revealInFocus, showInFocus, toggleFocus } from './focusState'
import { focusedTerminal, focusedTerminalId, focusTerminalWhenReady, terminalActions } from './terminalRegistry'
import { copyFolderPath, toggleChatView } from './nodes/WindowTools'
import { folderToKeep } from './startHints'
import { showFolderToast } from './FolderToast'
import { whenNodeDrawn } from './newNodeFocus'
import { closeWindowAsking } from './a11y/windowActions'
import { keyboardElement, windowFor, windowOfElement } from './a11y/keyboardAt'
import { savedViews } from './savedViews'
import { pinnedNoteText, sentSelectionText, worthPinning } from './pinOutput'
import { sendSummary, type SendResult } from './noteSend'
import { openSendToAgents, selectedAgents } from './sendToAgents'
import { duplicateOf } from './duplicateNode'
import { say } from './reader/readerUi'
import { copyLastReply, revealTranscript, saveConversation } from './lastReplyUi'
import { askToFixRun } from './runFixUi'

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export type NewForm = {
  kind: 'claude' | 'codex' | 'terminal' | 'ssh' | 'run' | 'team' | 'run-config' | 'trigger' | 'arm'
  at?: Point
  groupId?: string
  editId?: string
  /** Ask an agent to fix a failed run (runFixUi.ts): its folder and brief to start with, and the run to sit beside and link to. */
  fix?: { from: string; cwd: string; prompt: string }
} | null

/**
 * The window that window actions mean: one filling the canvas, the one the keyboard is in, or a single selected
 * session. Decided by where the keyboard is now (see a11y/keyboardAt.ts), not by the terminal typed in last.
 */
export function currentWindow(selected: string[]): string | null {
  const s = useStore.getState()
  const el = keyboardElement()
  const id = windowOfElement(el)
  const inTerminal = !!el?.classList.contains('xterm-helper-textarea')
  const node = selected.length === 1 ? s.doc?.nodes.find((n) => n.id === selected[0]) : undefined
  return windowFor(
    { terminal: inTerminal ? (id ?? focusedTerminalId()) : null, frame: id ? { id, session: isSessionNode(s.doc?.nodes.find((n) => n.id === id)) } : null },
    s.maximized,
    isSessionNode(node) ? node.id : null
  )
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
  openFromForm: (form: NonNullable<NewForm>, fields: { cwd: string; text?: string; chose?: boolean }) => void
  openLaunch: (form: NonNullable<NewForm>, choice: LaunchChoice) => void
  openSsh: (form: NonNullable<NewForm>, fields: { host: string; home: string }) => void
  saveTrigger: (form: NonNullable<NewForm>, fields: TriggerFields) => void
  defaultFolder: (groupId?: string) => string
  /** Where a new terminal of this profile (the default, with none) opens: see terminalFolderFor. */
  terminalFolder: (groupId?: string, profileId?: string) => string
  fitAll: () => void
} {
  const flow = useReactFlow<FlowNode, FlowEdge>()
  const lastFolder = useRef('')

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

    /** The canvas on screen, in canvas coordinates: the safe area, clear of the sidebar, dock, minimap and legend. */
    const visible = (): Rect | null => {
      const area = visibleArea(prefsRef.current.sidebar)
      const vp = flow.getViewport()
      return area && vp.zoom > 0 ? { x: (area.x - vp.x) / vp.zoom, y: (area.y - vp.y) / vp.zoom, width: area.width / vp.zoom, height: area.height / vp.zoom } : null
    }

    /** A group's worktree first, then the terminal profile's folder (the default's, with none picked), then as above. */
    const terminalFolder = (groupId?: string, profileId?: string): string =>
      terminalFolderFor({ worktree: groupFor(groupId)?.worktree?.path, profileCwd: profileFolder(profileId), fallback: defaultFolder(groupId) })

    /**
     * Where a new node goes: at the given screen point, else beside the one selected node if it's on screen, else in
     * the middle of the view. Placement keeps it clear of other nodes (see newNodes' placed).
     */
    const place = (at?: Point, groupId?: string): Place => {
      const group = groupFor(groupId)
      const view = visible()
      if (at) return { at: flow.screenToFlowPosition(at), group, doc: doc(), view }
      const selected = selectedRef.current.length === 1 ? doc().nodes.find((n) => n.id === selectedRef.current[0]) : undefined
      const shown = selected && view && inActiveProject(doc(), selected) ? absolutePosition(doc(), selected) : null
      const onScreen =
        shown && view && shown.x < view.x + view.width && view.x < shown.x + selected!.width && shown.y < view.y + view.height && view.y < shown.y + selected!.height
      return { ...(onScreen ? { beside: selected } : {}), group, doc: doc(), view }
    }

    /**
     * When a new node couldn't find room inside the safe area (the view is full), the view pans, at the same zoom, only
     * as far as it takes to show it: something just made is never left under the dock, the minimap or off the edge.
     */
    const reveal = (node: CanvasNode): void => {
      const view = visible()
      const vp = flow.getViewport()
      if (!view || !(vp.zoom > 0) || !inActiveProject(doc(), node)) return
      // A member of a group that isn't drawn yet has no place on screen to check.
      if (node.parentId && !doc().nodes.some((n) => n.id === node.parentId)) return
      // A minimal pan: nodes made just before stay in view too, whenever they all fit.
      const d = panToShow(view, { ...absolutePosition(doc(), node), width: node.width, height: node.height })
      if (d.x || d.y) void flow.setViewport({ x: vp.x - d.x * vp.zoom, y: vp.y - d.y * vp.zoom, zoom: vp.zoom }, { duration: reducedMotion() ? 0 : 220 })
    }

    const open = (node: CanvasNode, opts: { focus?: boolean } = {}): void => {
      dispatch({ op: 'addNode', node })
      reveal(node)
      if (isSessionNode(node)) void bridge.startNode(node.id).then((r) => noteRunProblem(node.id, r))
      // Made by the person just now, so it's what they'll type into next: selected, with the keyboard once it's built.
      if (opts.focus && isSessionNode(node)) {
        focusTerminalWhenReady(node.id)
        whenNodeDrawn(node.id, (id) => flow.getNode(id), (id) => setNodes((nodes) => nodes.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id }))))
      }
    }

    /** Fits everything into the safe area: the part of the canvas no chrome covers. */
    const fitAll = (): void => void flow.fitView({ padding: safePadding(8, prefsRef.current.sidebar), duration: 220 })

    const target = (nodeId?: string) => (nodeId ? terminalActions(nodeId) : focusedTerminal())

    /** Brings a node into view and gives its terminal the keyboard. A node in another project has to be drawn first. */
    const center = (id: string): void => {
      const go = (): void => {
        // Its terminal may not be built yet in a project just drawn: it takes the keyboard once it is. A long flight
        // passes through the overview, where the terminal is hidden and loses focus, so it's given again on arrival.
        focusTerminalWhenReady(id)
        void flow.fitView({ nodes: [{ id }], padding: safePadding(), maxZoom: 1, duration: 260 }).then(() => {
          // Unless something else took the keyboard on the way.
          const now = document.activeElement
          if (!now || now === document.body) focusTerminalWhenReady(id)
        })
      }
      if (flow.getNode(id)) go()
      // A switch draws the windows off screen a few a frame (stagedFlow.ts), so a far one can take more than 300 ms.
      else setTimeout(() => whenNodeDrawn(id, (n) => flow.getNode(n), go), 300)
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
      moveProjectTab: (step, id) => stepProjectTab(id ?? doc().activeProjectId, step),
      revealNode: (id) => {
        const node = doc().nodes.find((n) => n.id === id)
        if (!node) return
        bridge.markSeen(id)
        // Its project can't be shown until it's unarchived, so say so where that can be done.
        const archivedIn = doc().projects.find((p) => p.id === node.projectId && p.archivedAt !== undefined)
        if (archivedIn) return openProjects(`"${node.title}" is in the archived project "${archivedIn.name}". Unarchive it to open it.`)
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
      newTerminal: (at, groupId, profileId) =>
        open(newTerminal(place(at, groupId), crypto.randomUUID(), { cwd: terminalFolder(groupId, profileId), profile: pickedProfile(profileId) }), { focus: true }),
      newTerminalForm: (at, groupId) => setForm({ kind: 'terminal', at, groupId }),
      newSshForm: (at, groupId) => setForm({ kind: 'ssh', at, groupId }),
      newClaudeForm: (at, groupId) => setForm({ kind: 'claude', at, groupId }),
      newCodexForm: (at, groupId) => setForm({ kind: 'codex', at, groupId }),
      newRunForm: (at, groupId) => setForm({ kind: 'run', at, groupId }),
      newBrowser: (at, groupId) => open(newBrowser(place(at, groupId), crypto.randomUUID())),
      duplicateNode: (id) => {
        const src = doc().nodes.find((n) => n.id === id)
        if (!src) return
        // Beside the original, in its group if it's in one.
        const node = duplicateOf(src, { beside: src, group: groupFor(src.parentId ?? undefined), doc: doc(), view: visible() }, crypto.randomUUID(), pickedProfile)
        if (node) open(node, { focus: true })
      },
      setBrowserHeld: (id, held) => patchNode(id, { held }),
      toggleMute: (id) => patchNode(id, { muted: doc().nodes.find((n) => n.id === id)?.muted === true ? undefined : true }),
      reloadBrowser: (id) => void bridge.browserStep(id, 'reload'),
      spawnTeamForm: (at) => setForm({ kind: 'team', at }),
      editRunCommand: (id) => setForm({ kind: 'run', editId: id }),
      newRunConfigForm: (at, groupId) => setForm({ kind: 'run-config', at, groupId }),
      newTriggerForm: (at) => setForm({ kind: 'trigger', at }),
      editTrigger: (id) => setForm({ kind: 'trigger', editId: id }),
      armTrigger: (id) => setForm({ kind: 'arm', editId: id }),
      disarmTrigger: (id) => void bridge.disarmTrigger(id),
      runTriggerNow: (id) => void bridge.runTriggerNow(id),
      newSticky: (at) => {
        const node = newSticky(place(at), crypto.randomUUID())
        undoable('add note', [{ op: 'addNode', node }])
        reveal(node)
      },
      copyLastReply: (nodeId) => void copyLastReply(nodeId),
      saveConversation: (nodeId) => void saveConversation(nodeId),
      revealTranscript: (nodeId) => void revealTranscript(nodeId),
      askToFixRun: (nodeId) => void askToFixRun(nodeId),
      pinSelection: (nodeId) => {
        const source = doc().nodes.find((n) => n.id === nodeId)
        const selection = terminalActions(nodeId)?.selection()
        if (!source || !worthPinning(selection)) return
        // Beside the window it came from, cabled to it, in one undoable step.
        const at = { beside: source, group: null, doc: doc(), view: visible() }
        const node = { ...newSticky(at, crypto.randomUUID()), title: 'Pinned output', text: pinnedNoteText(source.title, selection, new Date()) }
        undoable('pin output', [
          { op: 'addNode', node },
          { op: 'addEdge', edge: { id: crypto.randomUUID(), from: nodeId, to: node.id, kind: 'link' } }
        ])
        reveal(node)
      },
      sendToAgents: () => openSendToAgents(selectedAgents(doc(), selectedRef.current).map((a) => a.id)),
      sendSelection: (nodeId, agentId) => {
        const source = doc().nodes.find((n) => n.id === nodeId)
        const agent = doc().nodes.find((n) => n.id === agentId)
        const selection = terminalActions(nodeId)?.selection()
        if (!source || !agent || !worthPinning(selection)) return
        // Through the same queue as a note's send arrow: a busy agent gets it once it's idle, and the line says which.
        void bridge
          .sendToAgent(agentId, sentSelectionText(source.title, selection))
          .catch((e: unknown): SendResult => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }))
          .then((result) => say(sendSummary([{ title: agent.title, result }]), result.ok))
      },
      // Not undoable: redoing it would bring the board back empty, losing what was drawn since. Deleting it is undoable.
      newWhiteboard: (at) => {
        const node = newWhiteboard(place(at), crypto.randomUUID())
        dispatch({ op: 'addNode', node })
        reveal(node)
      },
      group: (at) => {
        const members = groupMembers(doc(), selectedRef.current)
        const id = crypto.randomUUID()
        undoable('group', [
          { op: 'addNode', node: newGroup(doc(), placed({ ...place(at), group: null }, SIZES.group), id, members) },
          ...(members.length ? [{ op: 'setParent' as const, ids: members.map((m) => m.id), parentId: id }] : [])
        ])
      },
      closeSelected: () => closeNodes(selectedRef.current),
      closeNode: (id) => closeNodes([id]),
      renameNode: (id) => useStore.setState({ renaming: id }),
      restartNode: (id) => void restartNode(id),
      restartNodes: (ids) => {
        for (const id of ids) void restartNode(id)
      },
      renameWindow: (nodeId) => onWindow(nodeId, (id) => useStore.setState({ renaming: id })),
      restartWindow: (nodeId) => onWindow(nodeId, (id) => void restartNode(id)),
      closeWindow: (nodeId) => onWindow(nodeId, closeWindowAsking),
      toggleRecent,
      quit: () => void bridge.quitApp(),
      stopAllAndQuit: () => void bridge.stopAllAndQuit(),
      copy: (nodeId) => target(nodeId)?.copy(),
      paste: (nodeId) => target(nodeId)?.paste(),
      find: (nodeId) => target(nodeId)?.find(),
      refreshWindow: (nodeId) => onWindow(nodeId, refreshWindow),
      nameWithAi: (nodeId) => onWindow(nodeId, (id) => void nameWithAi(id)),
      toggleMaximize: (nodeId) => onWindow(nodeId, toggleMaximize),
      toggleChat: (nodeId) => onWindow(nodeId, toggleChatView),
      copyFolderPath: (nodeId) => onWindow(nodeId, copyFolderPath),
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
        // Centred in the safe area, so a big window isn't half under the sidebar.
        const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        const safe = visibleArea(prefsRef.current.sidebar)
        if (safe) void flow.setViewport(centredIn(safe, centre, flow.getZoom()), { duration: 200 })
        else void flow.setCenter(centre.x, centre.y, { zoom: flow.getZoom(), duration: 200 })
        terminalActions(next)?.focus()
      },
      undo,
      redo,
      selectAll: () => setNodes((nodes) => nodes.map((n) => ({ ...n, selected: true }))),
      zoomIn: () => void flow.zoomIn({ duration: 160 }),
      zoomOut: () => void flow.zoomOut({ duration: 160 }),
      zoomReset: () => void flow.zoomTo(1, { duration: 160 }),
      fitView: fitAll,
      saveView: (n) => {
        savedViews().set(doc().activeProjectId, n, flow.getViewport())
        say(`Saved this view as ${n}. Alt+${n} comes back to it.`, true)
      },
      goToView: (n) => {
        const view = savedViews().get(doc().activeProjectId, n)
        if (!view) return say(`No view is saved as ${n} in this project. Alt+Shift+${n} saves the one on screen.`)
        void flow.setViewport(view, { duration: reducedMotion() ? 0 : 220 }).then(() => dispatch({ op: 'setViewport', viewport: view }))
      },
      tidy: (ids) => {
        // Opens the preview (see TidyLayer): the selection or the group given, else the whole project.
        const picked = (ids ?? selectedRef.current).filter((id) => doc().nodes.some((n) => n.id === id && inActiveProject(doc(), n)))
        const scope = picked.length >= 2 || (picked.length === 1 && groupFor(picked[0])) ? { kind: 'selection' as const, ids: picked } : { kind: 'project' as const }
        openTidy({ projectId: doc().activeProjectId, scope, selection: picked, view: visible() })
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

    const openFromForm = (form: NonNullable<NewForm>, fields: { cwd: string; text?: string; profile?: string; chose?: boolean }): void => {
      lastFolder.current = fields.cwd || lastFolder.current
      // A project with no folder takes the one chosen for its first agent, so the next one starts with no picker.
      const keep = form.editId ? null : folderToKeep(doc(), form.kind, fields)
      if (keep) {
        dispatch({ op: 'patchProject', id: keep.projectId, patch: { folder: keep.folder } })
        showFolderToast(keep)
      }
      if (form.editId) {
        // Applies from the next run. Whatever's running now keeps running.
        dispatch({ op: 'patchNode', id: form.editId, patch: { command: fields.text ?? '', cwd: fields.cwd } })
        return
      }
      if (form.kind === 'team') {
        const p = place(form.at)
        // The lead is the default agent from Settings. Placed now, so it lands where the form was.
        void bridge.getSettings().then((settings) => {
          const agent = defaultAgentOf(settings)
          const lead = newClaude(p, crypto.randomUUID(), { cwd: fields.cwd, prompt: teamLeadPrompt(fields.text ?? ''), agent })
          open({ ...lead, title: TEAM_LEAD_TITLE }, { focus: true })
        })
        return
      }
      if (form.kind === 'run') {
        open(newRun(place(form.at, form.groupId), crypto.randomUUID(), { cwd: fields.cwd, command: fields.text ?? '' }), { focus: true })
        return
      }
      const id = crypto.randomUUID()
      const from = form.fix ? doc().nodes.find((n) => n.id === form.fix!.from) : undefined
      if (from && (form.kind === 'claude' || form.kind === 'codex')) {
        // Beside the failed run, and linked to it, so the agent can read its output and run it again.
        const made = newClaude({ beside: from, group: from.parentId ? groupFor(from.parentId) : null, doc: doc(), view: visible() }, id, { cwd: fields.cwd, prompt: fields.text, agent: form.kind })
        const node = { ...made, title: `Fix ${from.title}` }
        open(node, { focus: true })
        dispatch({ op: 'addEdge', edge: { id: crypto.randomUUID(), from: from.id, to: node.id, kind: 'link' } })
        return
      }
      const p = place(form.at, form.groupId)
      open(
        form.kind === 'claude' || form.kind === 'codex'
          ? newClaude(p, id, { cwd: fields.cwd, prompt: fields.text, agent: form.kind })
          : newTerminal(p, id, { cwd: fields.cwd, command: fields.text, profile: pickedProfile(fields.profile) }),
        { focus: true }
      )
    }

    const openSsh = (form: NonNullable<NewForm>, fields: { host: string; home: string }): void => {
      open(newSsh(place(form.at, form.groupId), crypto.randomUUID(), fields), { focus: true })
    }

    /** One run node, or for a compound a group holding one per configuration, each with its own state. Running is this click. */
    const openLaunch = (form: NonNullable<NewForm>, { folder, item }: LaunchChoice): void => {
      lastFolder.current = folder
      if (item.kind === 'config') {
        open(newLaunchRun(place(form.at, form.groupId), crypto.randomUUID(), { folder, name: item.name }))
        return
      }
      const gap = 24
      const size = { width: gap + item.members.length * (SIZES.run.width + gap), height: 64 + SIZES.run.height + gap }
      const group: GroupNode = {
        id: crypto.randomUUID(),
        kind: 'group',
        title: item.name,
        ...placed({ ...place(form.at), group: null }, size),
        parentId: null,
        worktree: null
      }
      dispatch({ op: 'addNode', node: group })
      item.members.forEach((name, i) => {
        const member = newLaunchRun({ group, doc: doc() }, crypto.randomUUID(), { folder, name })
        open({ ...member, x: gap + i * (SIZES.run.width + gap), y: 64 })
      })
    }

    const saveTrigger = (form: NonNullable<NewForm>, fields: TriggerFields): void => {
      // Changing what it sends disarms it. That's done in the reducer, so no route around it exists.
      if (form.editId) dispatch({ op: 'patchNode', id: form.editId, patch: fields })
      else dispatch({ op: 'addNode', node: newTrigger(place(form.at), crypto.randomUUID(), fields) })
    }

    return { commands, openFromForm, openLaunch, openSsh, saveTrigger, defaultFolder, terminalFolder, fitAll }
  }, [flow, prefsRef, selectedRef, setForm, setNodes, setPref, toggleRecent, openSettings, openPalette, setProjectFormOpen])
}
