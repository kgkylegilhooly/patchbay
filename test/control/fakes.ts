import { reduce } from '../../src/core/canvas/reduce'
import type { CanvasStore, SessionHost } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, ClaudeNode, GroupNode, TerminalNode } from '../../src/shared/model'

export function memoryStore(nodes: CanvasNode[] = []): CanvasStore {
  let doc: CanvasDoc = { version: 3, projects: [], activeProjectId: '', nodes, edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
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

export interface FakeRunner {
  started: string[]
  stopped: string[]
  startNode(id: string): Promise<void>
  stopNode(id: string): Promise<void>
}

export function fakeRunner(): FakeRunner {
  const started: string[] = []
  const stopped: string[] = []
  return {
    started,
    stopped,
    async startNode(id) {
      started.push(id)
    },
    async stopNode(id) {
      stopped.push(id)
    }
  }
}

export interface FakeHost extends SessionHost {
  writes: Array<[string, string]>
  output: Map<string, string>
  running: Set<string>
}

export function fakeHost(): FakeHost {
  const writes: Array<[string, string]> = []
  const output = new Map<string, string>()
  const running = new Set<string>()
  return {
    pid: () => null,
    writes,
    output,
    running,
    start() {},
    write: (id, data) => void writes.push([id, data]),
    resize() {},
    kill: async () => {},
    isRunning: (id) => running.has(id),
    snapshot: (id) => ({ data: output.get(id) ?? '', seq: 1 }),
    onOutput() {},
    onExit() {}
  }
}

const box = { x: 0, y: 0, width: 600, height: 400, parentId: null }

export const claudeNode = (id: string, over: Partial<ClaudeNode> = {}): ClaudeNode => ({
  ...box,
  id,
  kind: 'claude',
  title: id,
  cwd: process.cwd(),
  sessionId: null,
  transcriptPath: null,
  after: [],
  ...over
})

export const terminalNode = (id: string, over: Partial<TerminalNode> = {}): TerminalNode => ({
  ...box,
  id,
  kind: 'terminal',
  title: id,
  cwd: process.cwd(),
  ...over
})

export const groupNode = (id: string, over: Partial<GroupNode> = {}): GroupNode => ({
  ...box,
  id,
  kind: 'group',
  title: id,
  worktree: null,
  ...over
})
