import type { CanvasStore } from '../../shared/contract'
import type { ClaudeNode } from '../../shared/model'
import type { NodeRunner } from '../sessions/nodeRunner'
import type { StatusTracker } from '../sessions/statusTracker'

export interface AfterGate {
  /** Holds a node until these upstream nodes finish a turn. */
  arm(id: string, upstream: string[]): void
  /** Settles every held node. On launch, call this once to pick up nodes held in the loaded doc. */
  evaluate(): void
  /** Serves the Start now button: launches a held node whatever its upstream nodes are doing. */
  startNow(id: string): void
}

/**
 * The doc is the record of what's held: a node's `after` lists the upstream nodes still unfinished,
 * and an empty list means released. Turn counts reset each launch, so a finished upstream is removed
 * from the list as soon as it finishes. Closing an upstream also removes it (see reduce), which counts
 * as no longer waiting on it.
 */
export function createAfterGate({
  store,
  tracker,
  runner
}: {
  store: CanvasStore
  tracker: Pick<StatusTracker, 'get' | 'apply' | 'turnsCompleted' | 'onChange'>
  runner: Pick<NodeRunner, 'startNode'>
}): AfterGate {
  /** Nodes held and not yet launched. Only this tells a released node from one that was never held. */
  const armed = new Set<string>()
  let evaluating = false
  let again = false

  const hold = (id: string): void => {
    if (armed.has(id)) return
    armed.add(id)
    tracker.apply(id, { type: 'queued' })
  }

  const settle = (): void => {
    const nodes = store.get().nodes
    const present = new Set(nodes.map((n) => n.id))
    for (const id of armed) if (!present.has(id)) armed.delete(id)

    for (const node of nodes) {
      if (node.kind !== 'claude') continue
      const remaining = node.after.filter((up) => present.has(up) && tracker.turnsCompleted(up) === 0)
      if (remaining.length !== node.after.length) {
        store.dispatch({ op: 'patchNode', id: node.id, patch: { after: remaining } as Partial<ClaudeNode> })
      }
      if (remaining.length > 0) hold(node.id)
      else if (armed.delete(node.id)) void runner.startNode(node.id)
    }
  }

  /** What settle does can change the doc or a status, which brings the call back here. */
  const evaluate = (): void => {
    if (evaluating) {
      again = true
      return
    }
    evaluating = true
    try {
      do {
        again = false
        settle()
      } while (again)
    } finally {
      evaluating = false
    }
  }

  tracker.onChange(() => evaluate())
  store.subscribe(() => evaluate())

  return {
    arm(id, upstream) {
      // Armed first: the patch re-enters settle, which may release the node then and there.
      armed.add(id)
      store.dispatch({ op: 'patchNode', id, patch: { after: upstream } as Partial<ClaudeNode> })
      if (armed.has(id)) tracker.apply(id, { type: 'queued' })
      evaluate()
    },
    evaluate,
    startNow(id) {
      const wasArmed = armed.delete(id)
      store.dispatch({ op: 'patchNode', id, patch: { after: [] } as Partial<ClaudeNode> })
      if (wasArmed) void runner.startNode(id)
    }
  }
}
