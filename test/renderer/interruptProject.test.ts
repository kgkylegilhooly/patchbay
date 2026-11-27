import { expect, test, vi } from 'vitest'
import { canvasMenu, type MenuItem, type MenuState } from '../../src/renderer/menus'
import { workingInProject } from '../../src/renderer/restartStopped'
import { workMenu } from '../../src/renderer/workDock'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

// F67: agents doing the wrong thing across groups are stopped in one step, from the canvas or Work menu, after naming them.
const box = { x: 0, y: 0, width: 10, height: 10, parentId: null }
const agent = (id: string, projectId?: string): CanvasNode => ({ ...box, id, title: `Agent ${id}`, kind: 'claude', cwd: 'C:\\w', sessionId: null, transcriptPath: null, after: [], ...(projectId ? { projectId } : {}) }) as CanvasNode

test("the project's working agents, in any group: not another project's, nor ones waiting on you or idle", () => {
  const doc = { activeProjectId: 'p', nodes: [agent('a', 'p'), { ...agent('b', 'p'), parentId: 'g' } as CanvasNode, agent('c', 'p'), agent('d', 'q'), agent('e')] } as Pick<CanvasDoc, 'nodes' | 'activeProjectId'>
  const statuses = { a: 'working', b: 'working', c: 'needs-you', d: 'working', e: 'working' } as const
  expect(workingInProject(doc, statuses).map((n) => n.id)).toEqual(['a', 'b', 'e'])
  expect(workingInProject(null, statuses)).toEqual([])
})

const working = [
  { id: 'a', title: 'Parser' },
  { id: 'b', title: 'Docs' }
]

test('the canvas menu offers Interrupt N working agents, naming them before Esc goes to each', () => {
  const interruptNodes = vi.fn()
  const c = new Proxy({} as Parameters<typeof canvasMenu>[0], { get: (_t, key) => (key === 'interruptNodes' ? interruptNodes : () => {}) })
  const state = (projectWorking: typeof working) => ({ selectedCount: 0, canCopy: false, canFind: false, sidebar: false, minimap: false, legend: false, snap: false, canUndo: false, canRedo: false, projectWorking }) as unknown as MenuState
  const item = canvasMenu(c, state(working), { x: 0, y: 0 }).find((e): e is MenuItem => e !== 'separator' && e.id === 'interrupt-working')
  expect(item).toMatchObject({ label: 'Interrupt 2 working agents…', confirmTitle: 'Interrupt 2 working agents?' })
  expect(item?.confirm).toContain('Parser and Docs')
  item!.run()
  expect(interruptNodes).toHaveBeenCalledWith(['a', 'b'])
  expect(canvasMenu(c, state([]), { x: 0, y: 0 }).find((e) => e !== 'separator' && e.id === 'interrupt-working')).toBeUndefined()
})

test('the Work menu offers it too, only with agents working', () => {
  const interruptNodes = vi.fn()
  const items = (w: typeof working) => workMenu({ toggleRecent: vi.fn(), interruptNodes, stopRuns: vi.fn() }, { waiting: 0, triggersPaused: false, working: w }).filter((e): e is MenuItem => e !== 'separator')
  const item = items(working).find((i) => i.id === 'interrupt-working')
  expect(item?.label).toBe('Interrupt 2 working agents…')
  item!.run()
  expect(interruptNodes).toHaveBeenCalledWith(['a', 'b'])
  expect(items([]).find((i) => i.id === 'interrupt-working')).toBeUndefined()
})
