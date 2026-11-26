import { expect, test } from 'vitest'
import { removeProjectStopped } from '../../src/main/projects/remove'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'
import { reduce } from '../../src/core/canvas/reduce'

const agent = (id: string, projectId: string): CanvasNode =>
  ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 400, height: 300, parentId: null, projectId, cwd: 'C:\repo', prompt: '', sessionId: null, transcriptPath: null, after: [] }) as unknown as CanvasNode

function setup(): { doc: () => CanvasDoc; running: Set<string>; stopped: string[]; deps: Parameters<typeof removeProjectStopped>[0] } {
  let doc = {
    version: 1,
    activeProjectId: 'keep',
    projects: [
      { id: 'keep', name: 'Keep' },
      { id: 'gone', name: 'Gone' }
    ],
    nodes: [agent('a', 'gone'), agent('other', 'keep')],
    edges: [],
    closed: []
  } as unknown as CanvasDoc
  const running = new Set(['a', 'other'])
  const stopped: string[] = []
  const deps = {
    store: { get: () => doc, dispatch: (op: Parameters<typeof reduce>[1]) => void (doc = reduce(doc, op)) },
    stopSessions: async (ids: string[]) => {
      for (const id of ids) if (doc.nodes.some((n) => n.id === id)) (stopped.push(id), running.delete(id))
    },
    isRunning: (id: string) => running.has(id),
    stopNode: async (id: string) => void (stopped.push(id), running.delete(id))
  }
  return { doc: () => doc, running, stopped, deps }
}

// PJ2: an agent in the project ran `patchbay open-agent` while its project's sessions were being stopped.
test("a session started in the project while it's being deleted is stopped too, not left running with no window", async () => {
  const s = setup()
  const first = s.deps.stopSessions
  let opened = false
  s.deps.stopSessions = async (ids) => {
    if (!opened) {
      opened = true
      s.deps.store.dispatch({ op: 'addNode', node: agent('late', 'gone') })
      s.running.add('late')
    }
    await first(ids)
  }
  await removeProjectStopped(s.deps, 'gone', 1)
  expect(s.doc().projects.map((p) => p.id)).toEqual(['keep'])
  expect(s.doc().nodes.map((n) => n.id)).toEqual(['other'])
  expect([...s.running]).toEqual(['other'])
  expect(s.stopped).toEqual(['a', 'late'])
})

test('a start already under way, that finishes once the stops are done, is stopped after the removal', async () => {
  const s = setup()
  const first = s.deps.stopSessions
  // Not running when asked to stop, as a launch still waiting on its program; running a moment later.
  s.running.delete('a')
  s.deps.stopSessions = async (ids) => {
    await first(ids)
    s.running.add('a')
  }
  await removeProjectStopped(s.deps, 'gone', 1)
  expect(s.doc().nodes.map((n) => n.id)).toEqual(['other'])
  expect(s.running.has('a')).toBe(false)
})

test('a refused delete stops nothing', async () => {
  const s = setup()
  await removeProjectStopped(s.deps, 'nope', 1)
  expect(s.stopped).toEqual([])
  expect(s.doc().projects).toHaveLength(2)
})
