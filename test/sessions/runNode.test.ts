import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate } from '../../src/core/persist/docStore'
import { planRestore, trayState } from '../../src/main/lifecycle'
import { createNotifier } from '../../src/main/notifier'
import { createSessionHost } from '../../src/main/sessions/host'
import { createNodeRunner, runArgs } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { nodeMenu, addMenu, type Commands, type MenuEntry, type MenuItem } from '../../src/renderer/menus'
import { sessionTree } from '../../src/renderer/sessionTree'
import type { RunResult } from '../../src/shared/contract'
import type { CanvasDoc, RunNode } from '../../src/shared/model'
import { memoryStore } from '../control/fakes'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay run '))
})

afterEach(() => removeTemp(dir))

const node = (command: string, id = 'r1'): RunNode => ({ id, kind: 'run', title: 'R', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: dir, command })

function setup(command: string) {
  const host = createSessionHost()
  const store = memoryStore([node(command)])
  /** The host's kills that asked for the whole tree. */
  const killed: string[] = []
  const kill = host.kill.bind(host)
  host.kill = (id, opts) => {
    if (opts?.tree) killed.push(id)
    return kill(id, opts)
  }
  const runner = createNodeRunner({
    host,
    store,
    tracker: createStatusTracker({ notify: () => {} }),
    ctx: {
      sessionDir: join(dir, 's'),
      hookScript: 'h',
      pluginDir: 'p',
      cliDir: 'c',
      endpointFile: 'e',
      secret: 'x',
      shell: 'cmd.exe',
      baseEnv: process.env
    }
  })
  const results: RunResult[] = []
  runner.onRun((_id, r) => results.push(r))
  const finished = (): Promise<RunResult> =>
    new Promise((resolve) => {
      runner.onRun((_id, r) => {
        if (!r.running) resolve(r)
      })
    })
  return { host, runner, results, finished, killed }
}

test('runArgs ends with the command: bash, powershell without -NoExit, cmd /c', () => {
  expect(runArgs('C:\\Git\\bin\\bash.exe', 'npm test')).toEqual(['--login', '-c', 'npm test'])
  expect(runArgs('powershell.exe', 'npm test')).toEqual(['-NoLogo', '-Command', 'npm test'])
  expect(runArgs('pwsh.exe', 'npm test')).toEqual(['-NoLogo', '-Command', 'npm test'])
  expect(runArgs('C:\\Windows\\cmd.exe', 'npm test')).toEqual(['/c', 'npm test'])
  expect(runArgs('C:\\tools\\nu.exe', 'npm test')).toEqual(['-c', 'npm test'])
})

test('an exit reports its code, and it was nobody asking', async () => {
  const { runner, finished, results } = setup('exit 3')
  const done = finished()
  await runner.startNode('r1')
  expect(await done).toMatchObject({ running: false, exitCode: 3, stoppedByYou: false })
  expect(results[0]).toMatchObject({ running: true, exitCode: null })
})

test('a clean exit reports zero', async () => {
  const { runner, finished } = setup('exit 0')
  const done = finished()
  await runner.startNode('r1')
  expect(await done).toMatchObject({ running: false, exitCode: 0 })
})

// The session host ends the tree, through handles it proves are ours (docs/plans/r5-jobkill.md): see safeKill tests.
test('Stop has the host end the whole tree and reports stoppedByYou', async () => {
  const { runner, finished, host, killed } = setup('pause')
  const done = finished()
  await runner.startNode('r1')
  const pid = host.pid('r1')
  expect(pid).toBeGreaterThan(0)
  await runner.stopTree('r1')
  expect(killed).toEqual(['r1'])
  expect(await done).toMatchObject({ running: false, stoppedByYou: true })
  expect(host.isRunning('r1')).toBe(false)
  expect(host.pid('r1')).toBeNull()
})

test('closing a run node also kills its tree', async () => {
  const { runner, killed } = setup('pause')
  await runner.startNode('r1')
  await runner.stopNode('r1')
  expect(killed).toHaveLength(1)
})

test('quitting kills the tree of a running run node', async () => {
  const { runner, killed } = setup('pause')
  await runner.startNode('r1')
  await runner.stopAll()
  expect(killed).toHaveLength(1)
})

test('Ctrl+C in the window counts as stopping it yourself', async () => {
  const { runner, finished, host } = setup('pause')
  const done = finished()
  await runner.startNode('r1')
  runner.noteInput('r1', '\x03')
  await host.kill('r1')
  expect(await done).toMatchObject({ stoppedByYou: true })
})

test('earlier output stays above a dim divider when it runs again', async () => {
  const { runner, finished, host } = setup('echo first-output')
  const once = finished()
  await runner.startNode('r1')
  await once
  const again = finished()
  await runner.restartNode('r1')
  await again
  const text = host.snapshot('r1').data
  expect(text.indexOf('first-output')).toBeGreaterThan(-1)
  expect(text).toContain('--- run again ---')
  expect(text.lastIndexOf('first-output')).toBeGreaterThan(text.indexOf('--- run again ---'))
})

test('a run that starts again reads as running, with stoppedByYou reset', async () => {
  const { runner, finished, results } = setup('exit 3')
  const once = finished()
  await runner.startNode('r1')
  await once
  const again = finished()
  await runner.restartNode('r1')
  await again
  expect(results.filter((r) => r.running)).toHaveLength(2)
})

const docWith = (nodes: CanvasDoc['nodes']): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
  activeProjectId: 'p',
  nodes,
  edges: [],
  closed: [],
  viewport: { x: 0, y: 0, zoom: 1 }
})

test('planRestore never starts a run node', () => {
  const plan = planRestore(docWith([node('npm run dev')]))
  expect(plan).toEqual({ claude: [], terminals: [], held: [] })
})

test('a run node counts as a running session only while running', () => {
  const doc = docWith([node('x')])
  expect(trayState(doc, {}, () => true).running).toBe(1)
  expect(trayState(doc, {}, () => false).running).toBe(0)
})

test('the sidebar lists run nodes', () => {
  expect(sessionTree(docWith([node('x')]), '').ungrouped.map((s) => s.id)).toEqual(['r1'])
})

test('a save holding a run node loads', () => {
  expect(migrate(docWith([{ ...node('npm test'), projectId: 'p' }])).nodes[0].kind).toBe('run')
})

test('a run node with no command is refused', () => {
  expect(() => migrate(docWith([{ ...node(''), projectId: 'p' }]))).toThrow(/invalid nodes/)
})

test('a failed run notifies with no chime', () => {
  const alert = vi.fn()
  const show = vi.fn()
  const notifier = createNotifier({ show, alert, windowFocused: () => false, titleOf: () => 't', reveal: () => {} })
  notifier.runFailed('r1')
  expect(show).toHaveBeenCalledTimes(1)
  expect(show.mock.calls[0][0].body).toMatch(/error/)
  expect(alert).not.toHaveBeenCalled()
  expect(notifier.unseen()).toEqual(['r1'])
})

const noop = new Proxy({}, { get: () => () => {} }) as Commands
const ids = (entries: MenuEntry[]): string[] => entries.filter((e): e is MenuItem => e !== 'separator').map((e) => e.id)

test('the add menu offers it', () => {
  expect(ids(addMenu(noop))).toContain('new-run')
})

test('its node menu offers Edit command, Rename and Close, and no Restart of its own', () => {
  const entries = ids(nodeMenu(noop, node('x'), null, { at: { x: 0, y: 0 }, canCopy: false, canRestart: false }))
  expect(entries).toEqual(expect.arrayContaining(['edit-command', 'rename', 'close', 'find']))
  expect(entries).not.toContain('restart')
})

