import { randomUUID } from 'node:crypto'
import { inReadingOrder, formatComments, unsent } from '../../core/reader/comments'
import { outline } from '../../core/reader/outline'
import { lastLines } from '../../core/transcript/read'
import type { CanvasStore } from '../../shared/contract'
import { isSessionNode, type CanvasDoc, type CanvasNode, type Edge } from '../../shared/model'
import { archivedRefusal } from '../control/archived'
import { noGroup } from '../control/gone'
import { RpcRefusal } from '../control/server'
import type { Verbs } from '../control/verbs'
import type { CommentStore } from './commentStore'
import { plansFolder } from './planFind'
import type { DocsService } from './service'

export const DOC_VERBS = ['open-doc']

type Args = Record<string, unknown>

function refuse(message: string): never {
  throw new RpcRefusal(message)
}

function optional(args: Args, key: string): string | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') refuse(`--${key} must be text.`)
  return v
}

/**
 * The folders an agent may show files from: its own, its group's worktree, its project's, and where Claude Code's plan
 * mode keeps plans. A reader shows the whole file to the agent through `read`, so it mustn't reach further than the
 * agent's own work. The person can open anything the reader policy allows.
 */
export function agentFolders(doc: CanvasDoc, caller: CanvasNode, home: string): string[] {
  const group = caller.parentId ? doc.nodes.find((n) => n.id === caller.parentId) : undefined
  const project = doc.projects.find((p) => p.id === caller.projectId)
  return [
    ...(isSessionNode(caller) ? [caller.cwd] : []),
    ...(group?.kind === 'group' && group.worktree ? [group.worktree.path] : []),
    ...(project?.folder ? [project.folder] : []),
    plansFolder(home)
  ]
}

/**
 * Adds `patchbay open-doc --path FILE`, which shows a Markdown file to the person in a reader beside the agent, and
 * answers `patchbay read` on a reader with the file and the person's open comments. Everything else passes through.
 */
export function withDocVerbs(verbs: Verbs, { store, docs, comments }: { store: CanvasStore; docs: DocsService; comments: CommentStore }): Verbs {
  const find = (id: string): CanvasNode | undefined => store.get().nodes.find((n) => n.id === id)
  /** By id, or by a title only one node in the caller's project has, as the other verbs take it. */
  const named = (caller: CanvasNode, ref: string): CanvasNode | undefined => {
    const byId = find(ref)
    if (byId) return byId
    const want = ref.trim().toLowerCase()
    const same = store.get().nodes.filter((n) => n.projectId === caller.projectId && n.title.trim().toLowerCase() === want)
    return same.length === 1 ? same[0] : undefined
  }
  const linked = (a: string, b: string): boolean => store.get().edges.some((e) => e.kind === 'link' && ((e.from === a && e.to === b) || (e.from === b && e.to === a)))
  const add = (from: string, to: string, kind: Edge['kind']): void => store.dispatch({ op: 'addEdge', edge: { id: randomUUID(), from, to, kind } })

  return async (callerId, verb, args) => {
    const caller = find(callerId)
    if (verb === 'read' && caller && typeof args.node === 'string') {
      const node = named(caller, args.node)
      if (node?.kind === 'reader') {
        const archived = archivedRefusal(store.get(), caller, { node: node.id })
        if (archived) refuse(archived)
        if (node.openedBy !== callerId && !linked(callerId, node.id)) {
          refuse(`Can't read node "${node.id}": it isn't linked to you and you didn't open it. To see it, ask the person to draw a cable between it and you.`)
        }
        const tail = args.tail
        if (tail !== undefined && (!Number.isInteger(tail) || (tail as number) < 1)) refuse('--tail must be a whole number above 0.')
        const r = await docs.read(node.id)
        if (!r.ok) refuse(r.reason)
        const doc = outline(r.text)
        const all = comments.get(node.path)
        const open = inReadingOrder(all.filter((c) => !c.resolved), doc)
        const said = open.length ? formatComments({ title: node.title, path: node.path, comments: open, doc }) : 'The person has no open comments on it.'
        const waiting = unsent(all).length
        return {
          text: [`${node.title}: ${node.path} (read-only in the reader)`, '', lastLines(r.text, tail as number | undefined), '', '--- Comments ---', said, ...(waiting ? ['', `${waiting} of them not sent to anyone yet.`] : [])].join('\n')
        }
      }
    }
    if (!DOC_VERBS.includes(verb)) return verbs(callerId, verb, args)
    if (!caller) refuse(`Node "${callerId}" is no longer on the canvas.`)
    const groupArg = optional(args, 'group')
    const archived = archivedRefusal(store.get(), caller, groupArg === undefined ? {} : { group: named(caller, groupArg)?.id ?? groupArg })
    if (archived) refuse(archived)
    const path = optional(args, 'path')
    if (!path) refuse('--path is required: the Markdown file to show.')
    const groupId = optional(args, 'group')
    if (groupId !== undefined) {
      const g = named(caller, groupId)
      if (!g || g.projectId !== caller.projectId) refuse(noGroup(groupId))
      if (g.kind !== 'group') refuse(`Node "${groupId}" is not a group.`)
    }
    const r = await docs.openFile(path, { from: caller, title: optional(args, 'title'), openedBy: callerId, within: agentFolders(store.get(), caller, docs.home) })
    if (!r.ok) refuse(r.reason)
    if (groupId !== undefined && !r.existed) store.dispatch({ op: 'setParent', ids: [r.nodeId], parentId: named(caller, groupId)!.id })
    if (!r.existed) add(callerId, r.nodeId, 'opened')
    // Also when it was already open: the agent named the file, so it may read the comments on it.
    if (!linked(callerId, r.nodeId)) add(callerId, r.nodeId, 'link')
    const node = find(r.nodeId)
    return {
      id: r.nodeId,
      path: node?.kind === 'reader' ? node.path : path,
      ...(r.existed ? { note: 'It was already open, so that reader was brought into view.' } : {}),
      comments: 'The person can comment on it and send the comments to you. Read them any time with patchbay read --node <id>.'
    }
  }
}
