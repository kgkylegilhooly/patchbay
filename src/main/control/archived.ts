import type { CanvasDoc, CanvasNode } from '../../shared/model'
import { inArchivedProject } from '../../core/canvas/projectOps'
import { quoteTitle } from './whoami'

const NODE_ARGS = ['node', 'to', 'from', 'group']
const NODE_LISTS = ['nodes', 'ids', 'after']

const projectName = (doc: CanvasDoc, node: CanvasNode): string => quoteTitle(doc.projects.find((p) => p.id === node.projectId)?.name ?? 'archived')

/**
 * Why an agent's verb is refused because of an archived project, or null. An archived project's nodes can't be
 * reached or started: not by one of its own (whose sessions were stopped, but a late call may still arrive), and not
 * by naming one of them, whether by id or, already resolved, by title.
 */
export function archivedRefusal(doc: CanvasDoc, caller: CanvasNode, args: Record<string, unknown>): string | null {
  if (inArchivedProject(doc, caller)) {
    return `Your project ${projectName(doc, caller)} is archived, so its nodes can't be reached or started. The person can unarchive it from the projects manager.`
  }
  const named = [
    ...NODE_ARGS.map((k) => args[k]).filter((v): v is string => typeof v === 'string'),
    ...NODE_LISTS.flatMap((k) => (Array.isArray(args[k]) ? (args[k] as unknown[]) : [])).filter((v): v is string => typeof v === 'string')
  ]
  for (const id of named) {
    const node = doc.nodes.find((n) => n.id === id)
    if (node && inArchivedProject(doc, node)) {
      return `Node "${id}" is in the archived project ${projectName(doc, node)}, so it can't be reached or started. The person can unarchive it from the projects manager.`
    }
  }
  return null
}
