import type { CanvasStore } from '../../shared/contract'
import type { SessionFiles } from '../../shared/filesTouched'
import type { Verbs } from '../control/verbs'
import { RpcRefusal } from '../control/server'
import type { FilesTouchedService } from './service'

export const FILES_VERBS = ['files']

function refuse(message: string): never {
  throw new RpcRefusal(message)
}

/** What `patchbay files` prints: plain and short, newest first. */
export function describeFiles(files: SessionFiles, onlyTurn: boolean): unknown {
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
      ...(files.overlaps[f.path] ? { alsoEditedBy: files.overlaps[f.path].map((o) => `${o.title} (${o.nodeId})`) } : {})
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
    const linked = doc.edges.some((e) => e.kind === 'link' && ((e.from === callerId && e.to === id) || (e.from === id && e.to === callerId)))
    if (id !== callerId && node.openedBy !== callerId && !linked) {
      refuse(`Can't read node "${id}": it isn't linked to you and you didn't open it. To see what it edited, ask the person to draw a cable between it and you.`)
    }
    if (node.kind !== 'claude') refuse(`Node "${id}" is not an agent, so it has no edits to list.`)
    const files = await service.files(id)
    if (!files || files.files.length === 0) return { node: id, files: [], note: 'No file edits recorded for this session yet.' }
    return describeFiles(files, args.turn === true)
  }
}
