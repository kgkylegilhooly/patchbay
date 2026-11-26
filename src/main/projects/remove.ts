import { removeRefusal } from '../../core/canvas/projectOps'
import type { CanvasStore } from '../../shared/contract'

/**
 * Deleting a project: stop its sessions, then remove it with everything in it. Nothing marks the project first, as
 * archiving does, so a session can start in it meanwhile (an agent there running `patchbay open-agent`, or a start
 * already under way). Those are stopped too (PJ2): removed, they'd keep running with no window until the next start.
 */
export async function removeProjectStopped(
  deps: {
    store: Pick<CanvasStore, 'get' | 'dispatch'>
    /** Ends sessions that are still on the canvas, with what goes with them. See pb:dispatch. */
    stopSessions(ids: string[]): Promise<void>
    isRunning(id: string): boolean
    /** Ends one session, with or without its node. */
    stopNode(id: string): Promise<void>
  },
  id: string,
  at: number
): Promise<void> {
  if (removeRefusal(deps.store.get(), id)) return
  const inProject = (): string[] =>
    deps.store
      .get()
      .nodes.filter((n) => n.projectId === id)
      .map((n) => n.id)
  // Read again after each round, for what was added while the last one was stopping.
  const asked = new Set<string>()
  for (let round = 0; round < 3; round++) {
    const fresh = inProject().filter((n) => !asked.has(n))
    if (fresh.length === 0) break
    for (const n of fresh) asked.add(n)
    await deps.stopSessions(fresh)
  }
  // Read and removed in one go, so nothing joins the project in between.
  const removed = inProject()
  deps.store.dispatch({ op: 'removeProject', id, at })
  if (deps.store.get().projects.some((p) => p.id === id)) return
  // A start that finished after its stop, or one that came after the last round.
  await Promise.all(removed.filter((n) => deps.isRunning(n)).map((n) => deps.stopNode(n).catch(() => {})))
}
