import { useReactFlow } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { filterEntries, fileName, folderHint, KIND_FILTERS, pathKey, pathMessage, SOURCE_LABELS, withoutLongPrefix, type KindFilter, type ShelfEntry } from '../shared/fileShelf'
import { agentOf, AGENT_NAMES, inActiveProject, type ClaudeNode, type FileNode } from '../shared/model'
import { bridge } from './bridge'
import type { FlowNode } from './flowMapping'
import { askSendPath, checkFiles, closeFileShelf, copyPath, filesBridge, fileNotice, forgetShared, listShared, openFile, personMade, revealFile, stateOf, useFilesUi } from './fileShelfUi'
import { noteShared, pinFiles, setPlacer, typePathsInto } from './fileShelfActions'
import { Icon } from './icons'
import { ContextMenu } from './Menu'
import { shelfRowMenu } from './shelfRowMenu'
import type { Place } from './newNodes'
import { relativeTime } from './sidebarView'
import { useStore } from './store'
import { visibleArea } from './viewArea'
import { FileGlyph } from './nodes/FileNode'
import './fileShelf.css'
import { Panel } from './shell/Panel'

/** The node a point on screen is over, other than the one being dragged, and its kind. */
function nodeAt(x: number, y: number, except?: string): { id: string; el: Element } | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const nodeEl = el.closest('.react-flow__node')
    const id = nodeEl?.getAttribute('data-id')
    if (nodeEl && id && id !== except) return { id, el: nodeEl }
  }
  return null
}

/**
 * Dragging a file icon onto a terminal or agent window types its path there, and the icon goes back where it was.
 * True when it did, so the drag isn't kept as a move.
 */
export function dropFileOnWindow(e: MouseEvent | TouchEvent | React.MouseEvent, dragged: FlowNode, putBack: (id: string, at: { x: number; y: number }) => void): boolean {
  const node = dragged.data.node
  if (node.kind !== 'file') return false
  const point = 'clientX' in e ? e : e.changedTouches[0]
  if (!point) return false
  const over = nodeAt(point.clientX, point.clientY, node.id)
  if (!over || !typePathsInto(over.id, [node.path])) return false
  putBack(node.id, { x: node.x, y: node.y })
  const target = useStore.getState().doc?.nodes.find((n) => n.id === over.id)
  noteShared(node.projectId, [node.path], 'drop', target?.title)
  return true
}

const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files')

/**
 * Files dragged in from File Explorer. Onto a terminal or agent window, their paths are typed there; anywhere else on
 * the canvas, each becomes an icon. A whiteboard keeps its own picture drop, and a web page its own.
 */
function useExplorerDrop(): void {
  useEffect(() => {
    const over = (e: DragEvent): void => {
      if (!hasFiles(e) || e.defaultPrevented) return
      if (!(e.target instanceof Element) || !e.target.closest('.stage')) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'link'
    }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e) || e.defaultPrevented) return
      if (!(e.target instanceof Element) || !e.target.closest('.stage')) return
      // A drawer or form over the canvas isn't the canvas.
      if (e.target.closest('.drawer, .pop, .settings, .board, .shell')) return
      const files = filesBridge()
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => files?.pathForFile(f) ?? '').filter(Boolean)
      if (!paths.length) return
      e.preventDefault()
      const doc = useStore.getState().doc
      const target = nodeAt(e.clientX, e.clientY)
      const node = target ? doc?.nodes.find((n) => n.id === target.id) : undefined
      if (node && typePathsInto(node.id, paths)) {
        noteShared(node.projectId, paths, 'drop', node.title)
        return
      }
      pinFiles(paths, { at: { x: e.clientX, y: e.clientY }, groupId: node?.kind === 'group' ? node.id : undefined }, 'drop')
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
}

/** Gives the shelf and the terminal path menu a way to place new icons in view, and looks at files again on focus. */
function usePlacementAndChecks(): void {
  const flow = useReactFlow<FlowNode>()
  useEffect(() => {
    setPlacer(({ at, groupId, besideId }) => {
      const doc = useStore.getState().doc
      if (!doc) return null
      const groupNode = groupId ? doc.nodes.find((n) => n.id === groupId) : undefined
      const group = groupNode?.kind === 'group' ? groupNode : null
      const area = visibleArea(!!document.querySelector('.sidebar'))
      const vp = flow.getViewport()
      const view = area && vp.zoom > 0 ? { x: (area.x - vp.x) / vp.zoom, y: (area.y - vp.y) / vp.zoom, width: area.width / vp.zoom, height: area.height / vp.zoom } : null
      const beside = besideId ? doc.nodes.find((n) => n.id === besideId && inActiveProject(doc, n)) : undefined
      const place: Place = { group, doc, view }
      if (at) place.at = flow.screenToFlowPosition(at)
      else if (beside) place.beside = beside
      return place
    })
    const recheck = (): void => {
      const doc = useStore.getState().doc
      if (!doc) return
      const icons = doc.nodes.filter((n): n is FileNode => n.kind === 'file' && inActiveProject(doc, n))
      checkFiles(icons.map((n) => ({ path: n.path, network: personMade(n) })))
    }
    window.addEventListener('focus', recheck)
    return () => {
      setPlacer(null)
      window.removeEventListener('focus', recheck)
    }
  }, [flow])
}

const ROW_LIMIT = 300

function ShelfRow({ entry, projectId, now }: { entry: ShelfEntry; projectId: string; now: number }): React.JSX.Element {
  const state = useFilesUi((s) => stateOf(s.states, entry.path))
  const missing = state === 'missing'
  const shown = withoutLongPrefix(entry.path)
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; end: boolean } | null>(null)
  const rowMenu = shelfRowMenu({
    open: () => openFile(entry.path),
    reveal: () => revealFile(entry.path),
    copy: () => copyPath(entry.path),
    pin: () => pinFiles([entry.path], {}, 'pin'),
    send: () => askSendPath(entry.path),
    forget: () => forgetShared(projectId, entry.path)
  })
  return (
    <li
      className={`shelf-row${missing ? ' shelf-row-missing' : ''}${menu ? ' shelf-row-menu' : ''}`}
      data-shelf-path={entry.path}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ at: { x: e.clientX, y: e.clientY }, end: false })
      }}
    >
      <button type="button" className="shelf-main" title={`Open ${shown}`} onClick={() => openFile(entry.path)} onDoubleClick={(e) => e.preventDefault()}>
        <FileGlyph path={entry.path} folder={state === 'folder'} size={30} />
        <span className="shelf-text">
          <span className="shelf-name">
            <span className="shelf-name-text">{fileName(entry.path)}</span>
            {missing && <span className="shelf-missing">Missing</span>}
          </span>
          <span className="shelf-where" title={shown}>
            {folderHint(entry.path)}
          </span>
          <span className="shelf-meta">
            {SOURCE_LABELS[entry.source]}
            {entry.nodeTitle ? ` · ${entry.nodeTitle}` : ''} · {relativeTime(entry.at, now)}
          </span>
        </span>
      </button>
      <span className="shelf-actions">
        <button
          type="button"
          className="icon-btn"
          data-shelf-tool="menu"
          aria-haspopup="menu"
          aria-label={`More for ${fileName(entry.path)}`}
          title="Reveal, copy, pin, send or forget"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect()
            setMenu({ at: { x: box.right, y: box.bottom + 4 }, end: true })
          }}
        >
          <Icon name="more" size={16} />
        </button>
      </span>
      {menu && <ContextMenu at={menu.at} anchor={menu.end ? "end" : "start"} label={fileName(entry.path)} onClose={() => setMenu(null)} entries={rowMenu} />}
    </li>
  )
}

/** Every file shared in the project on screen, newest first. References only: forgetting one leaves the file alone. */
function Shelf(): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const projectId = doc?.activeProjectId ?? ''
  const project = doc?.projects.find((p) => p.id === projectId)
  const [entries, setEntries] = useState<ShelfEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    const load = (): void =>
      void listShared(projectId).then((list) => {
        if (!live) return
        setEntries(list)
        checkFiles(list.slice(0, 2000).map((e) => ({ path: e.path, network: e.source === 'drop' })))
      })
    load()
    const stop = filesBridge()?.onChanged((id) => id === projectId && load())
    return () => {
      live = false
      stop?.()
    }
  }, [projectId])
  useEffect(() => input.current?.focus(), [])

  const shown = useMemo(() => filterEntries(entries ?? [], query, kind), [entries, query, kind])
  const now = Date.now()
  return (
    <Panel kind="drawer" title={`Files${project ? ` in ${project.name}` : ''}`} icon="file" label="Files shelf" className="shelf-drawer" closeLabel="Close the Files shelf" onClose={closeFileShelf} initialFocus="none" flush>
      <div className="shelf-controls">
        <input ref={input} className="shelf-search" type="search" placeholder="Search by name or folder" aria-label="Search files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Focus starts here, so Esc here closes the shelf, as it does from anywhere else in it.
          data-own-esc=""
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            closeFileShelf()
          }}
        />
        <select aria-label="Type of file" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
          {KIND_FILTERS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </div>
      {entries === null ? (
        <p className="drawer-empty">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="drawer-empty">
          Files shared in this project show here: pictures pasted into a window, files dropped onto the canvas or a window, file icons, and browser evidence. Drag files from File Explorer onto the canvas to start.
        </p>
      ) : shown.length === 0 ? (
        <p className="drawer-empty">No file matches.</p>
      ) : (
        <ul className="shelf-list">
          {shown.slice(0, ROW_LIMIT).map((e) => (
            <ShelfRow key={pathKey(e.path)} entry={e} projectId={projectId} now={now} />
          ))}
          {shown.length > ROW_LIMIT && <li className="drawer-empty">{shown.length - ROW_LIMIT} more. Search to narrow it down.</li>}
        </ul>
      )}
    </Panel>
  )
}

/** "Send path to agent": the project's agents, those linked to the file's icon first. */
function SendPicker({ path }: { path: string }): React.JSX.Element {
  const doc = useStore((s) => s.doc)
  const agents = useMemo(() => {
    const all = (doc?.nodes ?? []).filter((n): n is ClaudeNode => n.kind === 'claude' && !!doc && inActiveProject(doc, n))
    const icons = new Set((doc?.nodes ?? []).filter((n) => n.kind === 'file' && pathKey(n.path) === pathKey(path)).map((n) => n.id))
    const linked = new Set((doc?.edges ?? []).flatMap((e) => (icons.has(e.from) ? [e.to] : icons.has(e.to) ? [e.from] : [])))
    return [...all.filter((a) => linked.has(a.id)), ...all.filter((a) => !linked.has(a.id))]
  }, [doc, path])
  const [to, setTo] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const chosen = agents.find((a) => a.id === to) ?? agents[0]
  const close = (): void => useFilesUi.setState({ sendPath: null })
  const send = async (): Promise<void> => {
    if (!chosen) return
    const r = await bridge.sendToAgent(chosen.id, pathMessage(path))
    if (!r.ok) return setProblem(r.reason)
    fileNotice(r.queued ? `Queued for ${chosen.title}.` : `Sent to ${chosen.title}.`)
    close()
  }
  return (
    <Panel
      kind="modal"
      title="Send path to agent"
      icon="arrow-right"
      className="shelf-send"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-solid" disabled={!chosen} onClick={() => void send()}>
            Send
          </button>
        </>
      }
    >
      <code className="shelf-send-path">{withoutLongPrefix(path)}</code>
      {agents.length ? (
        <label className="field">
          <span className="field-label">Agent</span>
          <select autoFocus value={chosen?.id ?? ''} onChange={(e) => setTo(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} ({AGENT_NAMES[agentOf(a)]})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="drawer-empty">There's no agent in this project to send it to.</p>
      )}
      {problem && <p className="shelf-problem">{problem}</p>}
    </Panel>
  )
}

/** The Files shelf, Send path to agent, the line that says how a file action went, and drops from File Explorer. */
export function FileShelfLayer(): React.JSX.Element {
  const open = useFilesUi((s) => s.open)
  const sendPath = useFilesUi((s) => s.sendPath)
  const notice = useFilesUi((s) => s.notice)
  useExplorerDrop()
  usePlacementAndChecks()
  return (
    <>
      {open && <Shelf />}
      {sendPath && <SendPicker key={sendPath} path={sendPath} />}
      {notice && (
        <div className="shelf-notice" role="status">
          {notice}
        </div>
      )}
    </>
  )
}

/** The top bar's Files button. */
export function FilesButton(): React.JSX.Element {
  const open = useFilesUi((s) => s.open)
  return (
    <button type="button" className={`bar-files${open ? ' bar-files-on' : ''}`} aria-pressed={open} title="Files shelf: every file shared in this project" onClick={() => useFilesUi.setState({ open: !open })}>
      <Icon name="file" size={15} />
      Files
    </button>
  )
}
