import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasStore, RunResult } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, ClaudeNode } from '../../src/shared/model'
import { createAfterGate } from '../../src/main/control/after'
import { createSetupGate } from '../../src/main/recipes/setupGate'
import { createRecipeService } from '../../src/main/recipes/service'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { reduce } from '../../src/core/canvas/reduce'

/** A store holding one project, as the app's does. */
export function projectStore(nodes: CanvasNode[] = [], folder = ''): CanvasStore {
  let doc: CanvasDoc = {
    version: 3,
    projects: [{ id: 'p1', name: 'P', folder, viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    nodes,
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
  const subs = new Set<(d: CanvasDoc) => void>()
  return {
    get: () => doc,
    dispatch(op) {
      const next = reduce(doc, op)
      if (next === doc) return
      doc = next
      for (const cb of [...subs]) cb(doc)
    },
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    }
  }
}

/** Starts nothing for real. A run node's result is set by the test, as the host would report it. */
export function fakeRunner() {
  const started: string[] = []
  const results: Record<string, RunResult> = {}
  const listeners: Array<(id: string, run: RunResult) => void> = []
  const report = (id: string, run: Partial<RunResult>): void => {
    results[id] = { running: false, exitCode: null, stoppedByYou: false, at: Date.now(), ...run }
    for (const cb of listeners) cb(id, results[id])
  }
  return {
    started,
    report,
    /** A setup step that ran and exited with this code. */
    exit: (id: string, code: number) => (report(id, { running: true }), report(id, { running: false, exitCode: code })),
    async startNode(id: string) {
      started.push(id)
    },
    runs: () => ({ ...results }),
    onRun(cb: (id: string, run: RunResult) => void) {
      listeners.push(cb)
    }
  }
}

/** Everything instantiation needs, with git and processes faked. */
export function recipeWorld(nodes: CanvasNode[] = [], folder = process.cwd()) {
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-recipes-'))
  const store = projectStore(nodes, folder)
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const gate = createAfterGate({ store, tracker, runner })
  const setupGate = createSetupGate({ store, tracker, runner, gate })
  const worktrees: Array<{ repo: string; branch: string }> = []
  const service = createRecipeService({
    store,
    runner,
    gate,
    setupGate,
    dataDir,
    launcher: 'C:\\app\\resources\\launch-run.cjs',
    toplevel: async () => folder,
    createWorktree: async (a) => {
      if (worktrees.some((w) => w.branch === a.branch)) throw new Error(`A branch named "${a.branch}" already exists`)
      worktrees.push(a)
      return { path: join(dataDir, 'wt', a.branch), branch: a.branch, repo: a.repo }
    }
  })
  const node = (id: string) => store.get().nodes.find((n) => n.id === id)
  const agent = (id: string) => node(id) as ClaudeNode
  return { dataDir, store, tracker, runner, gate, setupGate, service, worktrees, node, agent }
}
