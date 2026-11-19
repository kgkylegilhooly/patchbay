import type { CanvasStore } from '../../shared/contract'
import type { OverlapNote, SessionFiles } from '../../shared/filesTouched'
import type { Verbs } from '../control/verbs'
import { RpcRefusal } from '../control/server'
import type { FilesTouchedService } from './service'

export const FILES_VERBS = ['files']

function refuse(message: string): never {
  throw new RpcRefusal(message)
}

/** Names the other agents that edited a file: by title and id where the caller may read them, otherwise only counted. */
function alsoEditedBy(others: OverlapNote[], mayRead: (id: string) => boolean): string[] {
  const named = others.filter((o) => mayRead(o.nodeId)).map((o) => `${o.title} (${o.nodeId})`)
  const rest = others.length - named.length
  return rest ? [...named, `${rest} other agent${rest === 1 ? '' : 's'} you aren't linked to`] : named
}

/** What `patchbay files` prints: plain and short, newest first. */
export function describeFiles(files: SessionFiles, onlyTurn: boolean, mayRead: (id: string) => boolean = () => true): unknown {
  const latest = files.turns.at(-1)
  const shown = onlyTurn ? files.files.filter((f) => latest && (f.lastTurn === latest.turn || f.firstTurn === latest.turn)) : files.files
  return {
    node: files.nodeId,
    cwd: files.cwd,
    ...(latest ? { turn: latest.turn, turnStarted: new Date(latest.at).toISOString(), ...(latest.tree ? { snapshot: latest.tree } : latest.problem ? { snapshotProblem: latest.problem } : {}) } : {}),
    files: shown.map((f) => ({
      path: f.path,
      lastEdited: new Date(f.lastAt).toISOString(),
      turn: f.lastTurn,
      edits: f.edits,
      ...(f.confirmed ? {} : { unconfirmed: 'the transcript never said whether this edit succeeded' }),
      ...(files.overlaps[f.path] ? { alsoEditedBy: alsoEditedBy(files.overlaps[f.path], mayRead) } : {})
    })),
    ...(files.truncated ? { truncated: 'Older files were dropped from this list.' } : {}),
    note: 'From the session\'s own Edit, Write and patch calls. Files changed by shell commands are not listed.'
  }
}

/**
 * Adds `patchbay files`: the files a session edited. Read-only, for the caller itself or a node it opened or is
 * linked to, as `patchbay read` allows.
 */
export function withFilesVerbs(verbs: Verbs, { store, service }: { store: CanvasStore; service: FilesTouchedService }): Verbs {
  return async (callerId, verb, args) => {
    if (!FILES_VERBS.includes(verb)) return verbs(callerId, verb, args)
    const doc = store.get()
    const given = args.node
    if (given !== undefined && typeof given !== 'string') refuse('--node must be a node id.')
    const id = (given as string | undefined) ?? callerId
    const node = doc.nodes.find((n) => n.id === id)
    if (!node) refuse(`There is no node "${id}".`)
    const linkedTo = (other: string): boolean => doc.edges.some((e) => e.kind === 'link' && ((e.from === callerId && e.to === other) || (e.from === other && e.to === callerId)))
    const mayRead = (other: string): boolean => other === callerId || doc.nodes.find((n) => n.id === other)?.openedBy === callerId || linkedTo(other)
    if (!mayRead(id)) {
      refuse(`Can't read node "${id}": it isn't linked to you and you didn't open it. To see what it edited, ask the person to draw a cable between it and you.`)
    }
    if (node.kind !== 'claude') refuse(`Node "${id}" is not an agent, so it has no edits to list.`)
    const files = await service.files(id)
    if (!files || files.files.length === 0) return { node: id, files: [], note: 'No file edits recorded for this session yet.' }
    return describeFiles(files, args.turn === true, mayRead)
  }
}
