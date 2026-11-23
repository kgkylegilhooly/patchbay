import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CanvasStore } from '../../shared/contract'
import { isSessionNode, type CanvasDoc, type CanvasNode, type ReaderNode } from '../../shared/model'
import { docName, isDocPath, type OpenDoc, type ReadResult, type ReaderComment } from '../../shared/reader'
import { localPaths, openTerminalLink, type LinkDeps } from '../shellActions'
import type { CommentStore } from './commentStore'
import { linksStayLocal, type LinkFs } from './links'
import { findPlan, tailLines } from './planFind'
import { checkDocPath, docKey, insideFolder, MAX_DOC_BYTES, systemFolders } from './policy'
import { READER_DEFAULT, readerSize } from '../../core/reader/readerSize'

/** A reader's size when the window's isn't known. New readers are sized to the window: see core/reader/readerSize. */
export const READER_SIZE = READER_DEFAULT

type Fail = { ok: false; reason: string; missing?: boolean }
type Opened = { ok: true; nodeId: string; existed: boolean }

/** The file system calls the reader makes, so tests can stand in for them. */
export interface DocsFs {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<Pick<Stats, 'isFile' | 'size' | 'mtimeMs'>>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  mkdir(path: string): Promise<void>
  exists(path: string): boolean
}

/** Tells when a file changes. Main uses fs.watchFile, which keeps working when an editor replaces the file. */
export interface DocsWatcher {
  watch(path: string, changed: () => void): void
  unwatch(path: string): void
}

export interface DocsDeps {
  store: CanvasStore
  dataDir: string
  home: string
  comments: CommentStore
  fs: DocsFs
  watcher: DocsWatcher
  /** Tells the window that a watched file changed. */
  changed: (path: string) => void
  /** Where to put a node opened from another one. */
  near: (doc: CanvasDoc, opener: CanvasNode, size: { width: number; height: number }) => { x: number; y: number }
  /** Brings a node into view, for a document that was already open. */
  center?: (id: string) => void
  /** The visible canvas, in screen pixels, for sizing a new reader to it. Unknown in tests. */
  view?: () => { width: number; height: number } | null
  link: Omit<LinkDeps, 'home'>
  system?: string[]
  newId?: () => string
  /** lstat and readlink, for tests. Node's by default. */
  linkFs?: LinkFs
}

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === 'ENOENT'

/** The first top-level heading, as a title, without Markdown marks. */
export function titleFrom(text: string): string | null {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(text.split('\n').slice(0, 60).join('\n'))
  if (!m) return null
  const t = m[1].replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
  return t ? t.slice(0, 80) : null
}

export function createDocsService(d: DocsDeps) {
  const system = d.system ?? systemFolders()
  const newId = d.newId ?? randomUUID
  const find = (id: string): CanvasNode | undefined => d.store.get().nodes.find((n) => n.id === id)
  const readerOf = (id: string): ReaderNode | null => {
    const n = find(id)
    return n?.kind === 'reader' ? n : null
  }

  /** Whether a path may be read now: the policy on the path as given and as it really is, and that it's a small file. */
  const checkFile = async (path: string): Promise<{ ok: true; path: string; real: string; mtimeMs: number } | Fail> => {
    const given = checkDocPath(path, system)
    if (!given.ok) return given
    // Before realpath, which would open a link to a network share and so connect to it.
    const links = await linksStayLocal(given.path, d.linkFs)
    if (!links.ok) return links
    let real: string
    try {
      real = await d.fs.realpath(given.path)
    } catch (e) {
      if (missing(e)) return { ok: false, reason: `The file is gone: ${given.path}`, missing: true }
      return { ok: false, reason: `The file can't be read: ${(e as Error).message}` }
    }
    const really = checkDocPath(real, system)
    if (!really.ok) return { ok: false, reason: `${given.path} leads somewhere a reader can't open. ${really.reason}` }
    const st = await d.fs.stat(real)
    if (!st.isFile()) return { ok: false, reason: `That isn't a file: ${given.path}` }
    if (st.size > MAX_DOC_BYTES) return { ok: false, reason: `${docName(given.path)} is ${Math.round(st.size / 1024 / 1024)} MB, too large to read here.` }
    return { ok: true, path: given.path, real, mtimeMs: st.mtimeMs }
  }

  const readText = async (path: string): Promise<ReadResult> => {
    const c = await checkFile(path)
    if (!c.ok) return c
    try {
      const text = (await d.fs.readFile(c.path)).replace(/^\uFEFF/, '')
      return { ok: true, text, mtimeMs: c.mtimeMs, path: c.path }
    } catch (e) {
      if (missing(e)) return { ok: false, reason: `The file is gone: ${c.path}`, missing: true }
      return { ok: false, reason: `The file can't be read: ${(e as Error).message}` }
    }
  }

  /** A path as written by a person, a terminal or an agent, made full against a folder. The first form that exists. */
  const resolveFrom = (folder: string, target: string): string => {
    const local = localPaths(folder, target, d.home)
    if (!local.ok) return target
    return local.paths.find((p) => d.fs.exists(p)) ?? local.paths[0]
  }

  /**
   * Makes a reader node for a file, or brings forward the one already open on it in the same project. The file must
   * pass the policy and exist. `from` is the node it was opened from, which places it and is remembered.
   */
  const openFile = async (
    target: string,
    o: {
      from?: CanvasNode
      at?: { x: number; y: number }
      title?: string
      openedBy?: string
      projectId?: string
      /** For an agent: the folders the file must be in, as named and once symlinks are followed. */
      within?: string[]
    } = {}
  ): Promise<Opened | Fail> => {
    const folder = o.from && isSessionNode(o.from) ? o.from.cwd : o.from?.kind === 'reader' ? dirname(o.from.path) : d.home
    const path = resolveFrom(folder, target)
    if (o.within) {
      const c = await checkFile(path)
      if (!c.ok) return c
      const inside = (p: string): boolean => o.within!.some((f) => insideFolder(p, f))
      if (!inside(c.path) || !inside(c.real)) {
        return { ok: false, reason: `${c.path} isn't in your folder, your project's folder or ~/.claude/plans, so you can't open it in a reader. Ask the person to open it.` }
      }
    }
    const read = await readText(path)
    if (!read.ok) return read
    const doc = d.store.get()
    const projectId = o.projectId ?? o.from?.projectId ?? doc.activeProjectId
    const already = doc.nodes.find((n) => n.kind === 'reader' && (n.projectId ?? doc.activeProjectId) === projectId && docKey(n.path) === docKey(read.path))
    if (already) return { ok: true, nodeId: already.id, existed: true }
    const size = readerSize(d.view?.() ?? null, doc.viewport.zoom)
    const spot = o.at ?? (o.from ? d.near(doc, o.from, size) : { x: (80 - doc.viewport.x) / doc.viewport.zoom, y: (80 - doc.viewport.y) / doc.viewport.zoom })
    const node: ReaderNode = {
      id: newId(),
      kind: 'reader',
      title: o.title || titleFrom(read.text) || docName(read.path),
      path: read.path,
      ...size,
      x: Math.round(spot.x),
      y: Math.round(spot.y),
      parentId: null,
      projectId
    }
    if (o.from && o.from.kind !== 'reader') node.fromNodeId = o.from.id
    else if (o.from?.kind === 'reader' && o.from.fromNodeId) node.fromNodeId = o.from.fromNodeId
    if (o.openedBy) node.openedBy = o.openedBy
    d.store.dispatch({ op: 'addNode', node })
    return { ok: true, nodeId: node.id, existed: false }
  }

  /** Text that only exists in a transcript, written once to app data so it can be opened, watched and commented on. */
  const snapshot = async (text: string, name: string): Promise<string> => {
    const dir = join(d.dataDir, 'reader', 'snapshots')
    await d.fs.mkdir(dir)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'answer'
    const file = join(dir, `${slug}-${createHash('sha1').update(text).digest('hex').slice(0, 10)}.md`)
    if (!d.fs.exists(file)) await d.fs.writeFile(file, text)
    return file
  }

  // Watching: every file a reader node on the canvas names, and nothing else.
  const watched = new Map<string, string>()
  const syncWatches = (doc: CanvasDoc): void => {
    const want = new Map<string, string>()
    for (const n of doc.nodes) if (n.kind === 'reader' && checkDocPath(n.path, system).ok) want.set(docKey(n.path), n.path)
    for (const [key, path] of watched) {
      if (want.has(key)) continue
      d.watcher.unwatch(path)
      watched.delete(key)
    }
    for (const [key, path] of want) {
      if (watched.has(key)) continue
      watched.set(key, path)
      d.watcher.watch(path, () => d.changed(path))
    }
  }
  syncWatches(d.store.get())
  const unsubscribe = d.store.subscribe(syncWatches)

  return {
    home: d.home,
    checkFile,
    openFile,

    async read(nodeId: string): Promise<ReadResult> {
      const node = readerOf(nodeId)
      if (!node) return { ok: false, reason: 'That reader is no longer on the canvas.' }
      return readText(node.path)
    },

    async open(a: OpenDoc): Promise<{ ok: true; nodeId: string } | Fail> {
      if (typeof a?.path !== 'string') return { ok: false, reason: 'No file was given.' }
      const from = a.fromNodeId ? find(a.fromNodeId) : undefined
      const r = await openFile(a.path, { from, at: a.at })
      if (!r.ok) return r
      // The person asked for it, so it's brought into view, unless it was put where they dropped it.
      if (r.existed || !a.at) d.center?.(r.nodeId)
      return { ok: true, nodeId: r.nodeId }
    },

    /** The newest plan in an agent's conversation, or its newest long answer, opened beside it and linked to it. */
    async openPlan(agentId: string): Promise<{ ok: true; nodeId: string; what: 'plan file' | 'plan' | 'answer' } | Fail> {
      const agent = find(agentId)
      if (agent?.kind !== 'claude') return { ok: false, reason: 'Only an agent window has a plan.' }
      if (!agent.transcriptPath) return { ok: false, reason: `${agent.title} hasn't started a conversation yet.` }
      let lines: string[]
      try {
        lines = await tailLines(agent.transcriptPath)
      } catch (e) {
        if (missing(e)) return { ok: false, reason: `${agent.title}'s conversation no longer exists.` }
        return { ok: false, reason: `${agent.title}'s conversation couldn't be read: ${(e as Error).message}` }
      }
      const found = findPlan(lines, d.home)
      if (!found) return { ok: false, reason: `There's no plan or long answer in ${agent.title}'s conversation yet.` }
      const path = found.kind === 'file' ? found.path : await snapshot(found.text, `${agent.title} ${found.what}`)
      const title = found.kind === 'text' ? titleFrom(found.text) ?? `${agent.title}: ${found.what === 'plan' ? 'plan' : 'answer'}` : undefined
      const r = await openFile(path, { from: agent, title })
      if (!r.ok) return r
      // Linked, so the agent can read the comments with patchbay read, and the cable shows where the plan came from.
      if (!r.existed) d.store.dispatch({ op: 'addEdge', edge: { id: newId(), from: agent.id, to: r.nodeId, kind: 'link' } })
      d.center?.(r.nodeId)
      return { ok: true, nodeId: r.nodeId, what: found.what }
    },

    comments(nodeId: string): { ok: true; comments: ReaderComment[] } | Fail {
      const node = readerOf(nodeId)
      if (!node) return { ok: false, reason: 'That reader is no longer on the canvas.' }
      return { ok: true, comments: d.comments.get(node.path) }
    },

    async saveComments(nodeId: string, comments: ReaderComment[]): Promise<{ ok: true } | Fail> {
      const node = readerOf(nodeId)
      if (!node) return { ok: false, reason: 'That reader is no longer on the canvas.' }
      if (!Array.isArray(comments)) return { ok: false, reason: 'Those comments are not a list.' }
      if (d.comments.loadProblem) return { ok: false, reason: d.comments.loadProblem }
      await d.comments.set(node.path, comments)
      return { ok: true }
    },

    /**
     * A link in a document. Another Markdown file opens in a reader beside this one; anything else goes the way a
     * terminal link does (only http and https reach the browser, and runnable files are only shown in their folder).
     * Relative links are relative to the document's folder.
     */
    async openLink(nodeId: string, href: string): Promise<{ ok: true } | Fail> {
      const node = readerOf(nodeId)
      if (!node) return { ok: false, reason: 'That reader is no longer on the canvas.' }
      if (typeof href !== 'string' || !href.trim() || href.startsWith('#')) return { ok: true }
      const scheme = /^[a-z][a-z0-9+.-]+:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)
      const bare = href.replace(/#.*$/, '')
      if ((!scheme || /^file:/i.test(href)) && isDocPath(bare)) {
        const r = await openFile(bare, { from: node })
        if (!r.ok) return r
        d.center?.(r.nodeId)
        return { ok: true }
      }
      return openTerminalLink(dirname(node.path), href, { ...d.link, home: d.home })
    },

    stop(): void {
      unsubscribe()
      for (const path of watched.values()) d.watcher.unwatch(path)
      watched.clear()
    }
  }
}

export type DocsService = ReturnType<typeof createDocsService>
