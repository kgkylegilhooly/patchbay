import type { CanvasStore, RunResult } from '../../shared/contract'
import type { ClaudeNode, SetupWait } from '../../shared/model'
import type { AfterGate } from '../control/after'
import type { NodeRunner } from '../sessions/nodeRunner'
import type { StatusTracker } from '../sessions/statusTracker'

export interface SetupGate {
  /** Holds an agent until these setup run nodes exit with code 0, then arms it after `after`, or starts it. */
  hold(id: string, wait: SetupWait): void
  /** Settles every held agent. On launch, call this once the run results from the host are in. */
  evaluate(): void
  /** Serves Start anyway: starts the agent whatever its setup is doing. */
  startAnyway(id: string): Promise<void>
}

/**
 * Keeps recipe agents queued until their setup succeeds. It's separate from the starts-after gate: that one waits for
 * agents to finish a turn, this one for commands to exit. The doc is the record, as there: an agent's `setupWait`
 * lists the steps still to succeed, so a hold outlasts a restart.
 *
 * A step that fails, is stopped or is closed leaves its agents queued, saying which step and why. Running that step
 * again and having it succeed releases them.
 */
export function createSetupGate({
  store,
  tracker,
  runner,
  gate
}: {
  store: CanvasStore
  tracker: Pick<StatusTracker, 'get' | 'apply' | 'onChange'>
  runner: Pick<NodeRunner, 'startNode' | 'runs' | 'onRun'>
  gate: Pick<AfterGate, 'arm'>
}): SetupGate {
  let evaluating = false
  let again = false
  /** Agents this launch has set queued, so one the person starts some other way is noticed. */
  const queued = new Set<string>()

  const patch = (id: string, setupWait: SetupWait | undefined): void =>
    store.dispatch({ op: 'patchNode', id, patch: { setupWait } as Partial<ClaudeNode> })

  const release = (node: ClaudeNode, wait: SetupWait): void => {
    queued.delete(node.id)
    patch(node.id, undefined)
    if (wait.after.length) gate.arm(node.id, wait.after)
    else void runner.startNode(node.id)
  }

  const settle = (): void => {
    const doc = store.get()
    const present = new Map(doc.nodes.map((n) => [n.id, n]))
    const runs: Record<string, RunResult> = runner.runs()
    for (const node of doc.nodes) {
      if (node.kind !== 'claude' || !node.setupWait) continue
      // Read with care, since the canvas file can be edited by hand: a hold waits only for the steps it still names.
      const raw = node.setupWait
      const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      const wait: SetupWait = { ...raw, steps: ids(raw.steps), after: ids(raw.after), recipe: typeof raw.recipe === 'string' ? raw.recipe : 'a recipe' }
      // Started by the person some other way: the hold no longer means anything.
      const status = tracker.get(node.id)
      if (queued.has(node.id) && status !== 'queued') {
        queued.delete(node.id)
        patch(node.id, undefined)
        continue
      }
      let failed: SetupWait['failed']
      const remaining = wait.steps.filter((step) => {
        const run = runs[step]
        const stepNode = present.get(step)
        if (!stepNode) {
          failed ??= { step, title: wait.failed?.step === step ? wait.failed.title : 'A setup step', exitCode: null, why: 'closed' }
          return true
        }
        if (!run || run.running) return true
        if (run.exitCode === 0 && !run.stoppedByYou) return false
        failed ??= { step, title: stepNode.title, exitCode: run.exitCode, why: run.stoppedByYou ? 'stopped' : 'exit' }
        return true
      })
      // A failure shown stays until that step runs again, which is what clears it.
      const shownFailure = wait.failed && remaining.includes(wait.failed.step) && !runs[wait.failed.step]?.running && present.has(wait.failed.step) ? wait.failed : undefined
      const nextFailed = failed ?? shownFailure
      if (remaining.length === 0) {
        release(node, wait)
        continue
      }
      if (remaining.length !== wait.steps.length || JSON.stringify(nextFailed) !== JSON.stringify(wait.failed)) {
        const next: SetupWait = { steps: remaining, after: wait.after, recipe: wait.recipe }
        if (nextFailed) next.failed = nextFailed
        patch(node.id, next)
      }
      if (status !== 'queued') tracker.apply(node.id, { type: 'queued' })
      queued.add(node.id)
    }
  }

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

  runner.onRun(() => evaluate())
  tracker.onChange(() => evaluate())
  store.subscribe(() => evaluate())

  return {
    hold(id, wait) {
      // Marked queued first, so the evaluation the patch sets off doesn't take it for one started by hand.
      tracker.apply(id, { type: 'queued' })
      queued.add(id)
      patch(id, wait)
      evaluate()
    },
    evaluate,
    async startAnyway(id) {
      const node = store.get().nodes.find((n) => n.id === id)
      if (node?.kind !== 'claude' || !node.setupWait) return
      queued.delete(id)
      patch(id, undefined)
      await runner.startNode(id)
    }
  }
}
