import { expect, test, vi } from 'vitest'
import { canvasMenu, nodeMenu, stopRunsEntry, type Commands, type MenuItem, type MenuState } from '../../src/renderer/menus'
import { runningIn, runningInProject } from '../../src/renderer/restartStopped'
import { workMenu } from '../../src/renderer/workDock'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

// F73: after a session, dev servers and watchers keep running, each stopped by hand. These stop them in one step.
const box = { x: 0, y: 0, width: 400, height: 300, parentId: null as string | null, projectId: 'p' }
const group = (id: string, parentId: string | null = null): CanvasNode => ({ ...box, id, title: id, kind: 'group', worktree: null, parentId }) as CanvasNode
const run = (id: string, parentId: string | null, projectId = 'p'): CanvasNode => ({ ...box, id, title: `Run ${id}`, kind: 'run', cwd: 'C:\\a', command: 'npm run dev', parentId, projectId }) as CanvasNode
const shell = (id: string, parentId: string | null): CanvasNode => ({ ...box, id, title: id, kind: 'terminal', cwd: 'C:\\a', parentId })
const on = { running: true, exitCode: null }
const off = { running: false, exitCode: 0 }

test("the running commands in a group, at any depth: not ended ones, terminals, or another group's", () => {
  const nodes = [group('g'), group('inner', 'g'), run('a', 'g'), run('b', 'inner'), run('c', 'g'), shell('t', 'g'), run('out', null)]
  const runs = { a: on, b: on, c: off, t: on, out: on }
  expect(runningIn(nodes, 'g', runs).map((n) => n.id)).toEqual(['a', 'b'])
})

test("the project's running commands, in any group: not another project's", () => {
  const doc = { activeProjectId: 'p', nodes: [run('a', null), run('b', 'g'), run('c', null), run('d', null, 'q')] } as Pick<CanvasDoc, 'nodes' | 'activeProjectId'>
  expect(runningInProject(doc, { a: on, b: on, c: off, d: on }).map((n) => n.id)).toEqual(['a', 'b'])
  expect(runningInProject(null, { a: on })).toEqual([])
})

const running = [
  { id: 'a', title: 'Dev server' },
  { id: 'b', title: 'Watch tests' },
  { id: 'c', title: 'Docs' }
]

test('Stop N running commands asks first, naming them, then stops each', () => {
  const stopRuns = vi.fn()
  const [item] = stopRunsEntry({ stopRuns }, running) as MenuItem[]
  expect(item).toMatchObject({ id: 'stop-runs', label: 'Stop 3 running commands…', confirmTitle: 'Stop 3 running commands?', danger: true })
  expect(item.confirm).toContain('"Dev server", "Watch tests" and "Docs"')
  item.run()
  expect(stopRuns).toHaveBeenCalledWith(['a', 'b', 'c'])
  expect((stopRunsEntry({ stopRuns }, running.slice(0, 1)) as MenuItem[])[0].label).toBe('Stop 1 running command…')
  expect(stopRunsEntry({ stopRuns }, [])).toEqual([])
})

const find = (entries: ReturnType<typeof canvasMenu>): MenuItem | undefined => entries.find((e): e is MenuItem => e !== 'separator' && e.id === 'stop-runs')

test('the canvas menu, the Work menu and a group menu offer it, only with commands running', () => {
  const stopRuns = vi.fn()
  const c = new Proxy({} as Commands, { get: (_t, key) => (key === 'stopRuns' ? stopRuns : () => {}) })
  const state = (projectRunning: typeof running) => ({ selectedCount: 0, canCopy: false, canFind: false, sidebar: false, minimap: false, legend: false, snap: false, canUndo: false, canRedo: false, projectRunning }) as unknown as MenuState
  expect(find(canvasMenu(c, state(running), { x: 0, y: 0 }))?.label).toBe('Stop 3 running commands…')
  expect(find(canvasMenu(c, state([]), { x: 0, y: 0 }))).toBeUndefined()

  const work = (r: typeof running) => find(workMenu({ toggleRecent: vi.fn(), interruptNodes: vi.fn(), stopRuns }, { waiting: 0, triggersPaused: false, running: r }))
  expect(work(running)?.label).toBe('Stop 3 running commands…')
  expect(work([])).toBeUndefined()

  const g = group('g')
  const menu = (r: typeof running) => find(nodeMenu(c, g, null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false, running: r }))
  menu(running.slice(0, 2))!.run()
  expect(stopRuns).toHaveBeenCalledWith(['a', 'b'])
  expect(menu([])).toBeUndefined()
})
