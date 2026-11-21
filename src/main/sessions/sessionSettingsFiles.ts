import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CanvasStore } from '../../shared/contract'

/**
 * The settings file each Claude node starts with, `<sessionDir>/<node>.settings.json`. With http hooks it holds the
 * node's hook token (see httpHook in claudeLaunch.ts), so it goes when the node does, rather than staying in the profile
 * for good. A node that comes back, as by undo, writes a new one when it starts.
 */

const SUFFIX = '.settings.json'

export function settingsFileFor(sessionDir: string, nodeId: string): string {
  return join(sessionDir, `${encodeURIComponent(nodeId)}${SUFFIX}`)
}

export function removeSessionSettings(sessionDir: string, nodeId: string): void {
  try {
    rmSync(settingsFileFor(sessionDir, nodeId), { force: true })
  } catch {
    // Held open for a moment: the prune at the next start takes it.
  }
}

/** Removes the files of nodes that are gone, as ones deleted by an older build or while the app was closed. */
export function pruneSessionSettings(sessionDir: string, keep: (nodeId: string) => boolean): string[] {
  let names: string[]
  try {
    names = readdirSync(sessionDir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!name.endsWith(SUFFIX)) continue
    let nodeId: string
    try {
      nodeId = decodeURIComponent(name.slice(0, -SUFFIX.length))
    } catch {
      continue
    }
    if (keep(nodeId)) continue
    removeSessionSettings(sessionDir, nodeId)
    removed.push(nodeId)
  }
  return removed
}

/**
 * Calls back for each Claude node that leaves the canvas, however it was removed: closed by the person, by an agent's
 * `patchbay close`, with its project, and so on. Returns the unsubscribe.
 */
export function onClaudeNodesRemoved(store: CanvasStore, removed: (nodeId: string) => void): () => void {
  const claudeIds = (): Set<string> => new Set(store.get().nodes.filter((n) => n.kind === 'claude').map((n) => n.id))
  let before = claudeIds()
  return store.subscribe(() => {
    const now = claudeIds()
    for (const id of before) if (!now.has(id)) removed(id)
    before = now
  })
}
