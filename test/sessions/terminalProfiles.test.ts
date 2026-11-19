import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { createNodeRunner, type NodeRunnerContext } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createStartupTyper, PROMPT_QUIET_MS, PROMPT_WAIT_MAX_MS } from '../../src/main/sessions/terminalStart'
import type { CanvasStore, SessionHost, SessionSpec } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, TerminalNode } from '../../src/shared/model'
import type { Settings } from '../../src/shared/settings'
import { builtInProfiles, GIT_BASH, type TerminalProfile } from '../../src/shared/terminalProfiles'

const PASTE_ON = '\x1b[?2004h'

function memoryStore(nodes: CanvasNode[]): CanvasStore {
  let doc: CanvasDoc = { version: 3, projects: [], activeProjectId: '', nodes, edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }
  return {
    get: () => doc,
    dispatch(op) {
      doc = reduce(doc, op)
    },
    subscribe: () => () => {}
  }
}

function fakeHost() {
  const running = new Set<string>()
  const outputs: Array<(id: string, data: string, seq: number) => void> = []
  const exits: Array<(id: string, code: number) => void> = []
  const specs: SessionSpec[] = []
  const written: Array<[string, string]> = []
  const host: SessionHost & { specs: SessionSpec[]; written: Array<[string, string]>; emit(id: string, data: string): void; exit(id: string): void } = {
    specs,
    written,
    pid: () => null,
    start(spec) {
      specs.push(spec)
      running.add(spec.nodeId)
    },
    write: (id, data) => void written.push([id, data]),
    resize() {},
    async kill(id) {
      host.exit(id)
    },
    isRunning: (id) => running.has(id),
    snapshot: () => ({ data: '', seq: 0 }),
    onOutput: (cb) => void outputs.push(cb),
    onExit: (cb) => void exits.push(cb),
    emit: (id, data) => outputs.forEach((cb) => cb(id, data, 0)),
    exit(id) {
      if (!running.delete(id)) return
      exits.forEach((cb) => cb(id, 0))
    }
  }
  return host
}

const vs: TerminalProfile = { id: 'custom:vs', name: 'VS prompt', program: 'cmd.exe', args: ['/k', 'C:\\VS\\vcvars64.bat'] }
const proj: TerminalProfile = { id: 'custom:proj', name: 'Project', program: GIT_BASH, args: ['--login', '-i'], startupCommand: 'cd ~/proj && nvm use' }
const builtIns = builtInProfiles({ gitBash: true })

const terminal = (over: Partial<TerminalNode> = {}): TerminalNode => ({ id: 't', kind: 'terminal', title: 'Shell', x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: 'C:\\work', ...over })

function setup(nodes: CanvasNode[], settings: Settings) {
  const store = memoryStore(nodes)
  const host = fakeHost()
  let current = settings
  const ctx: NodeRunnerContext = {
    sessionDir: 'C:/sessions',
    hookScript: 'C:/hook.cjs',
    pluginDir: 'C:/skill',
    cliDir: 'C:/cli',
    endpointFile: 'C:/endpoint.json',
    secret: 'sec',
    claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
    baseEnv: { PATH: 'C:\\Windows' },
    settings: () => current,
    builtInProfiles: () => builtIns
  }
  const runner = createNodeRunner({ host, tracker: createStatusTracker({ notify: () => {} }), store, ctx })
  const node = (id = 't') => store.get().nodes.find((n) => n.id === id) as TerminalNode
  return { store, host, runner, node, change: (s: Settings) => (current = s) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('a terminal started with a profile', () => {
  test('runs the profile program with its arguments as given', async () => {
    const { runner, host } = setup([terminal({ profile: 'custom:vs' })], { terminalProfiles: [vs, proj] })
    await runner.startNode('t')
    expect(host.specs[0]).toMatchObject({ file: 'cmd.exe', args: ['/k', 'C:\\VS\\vcvars64.bat'], cwd: 'C:\\work' })
  })

  test('types its startup command once, when bash says its prompt is ready', async () => {
    const { runner, host } = setup([terminal({ profile: 'custom:proj' })], { terminalProfiles: [vs, proj] })
    await runner.startNode('t')
    host.emit('t', 'Welcome\r\n')
    await vi.advanceTimersByTimeAsync(PROMPT_QUIET_MS * 3)
    // A slow login script can pause, so for Git Bash quiet alone isn't the prompt.
    expect(host.written).toEqual([])
    host.emit('t', `${PASTE_ON}$ `)
    expect(host.written).toEqual([['t', 'cd ~/proj && nvm use\r']])
    host.emit('t', `${PASTE_ON}$ `)
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS)
    expect(host.written).toHaveLength(1)
  })

  test("types the node's own command after the startup command, and only the startup command on restore", async () => {
    const t = setup([terminal({ profile: 'custom:proj', command: 'npm test' })], { terminalProfiles: [vs, proj] })
    await t.runner.startNode('t')
    t.host.emit('t', PASTE_ON)
    expect(t.host.written).toEqual([['t', 'cd ~/proj && nvm use\rnpm test\r']])

    const r = setup([terminal({ profile: 'custom:proj', command: 'npm run deploy' })], { terminalProfiles: [vs, proj] })
    await r.runner.startNode('t', { restored: true })
    r.host.emit('t', PASTE_ON)
    expect(r.host.written).toEqual([['t', 'cd ~/proj && nvm use\r']])
  })

  test('records the profile it started with, and restarts with it after the default changes', async () => {
    const { runner, host, node, change } = setup([terminal()], { terminalProfiles: [vs, proj], defaultTerminalProfile: 'custom:vs' })
    await runner.startNode('t')
    expect(node().profile).toBe('custom:vs')
    change({ terminalProfiles: [vs, proj], defaultTerminalProfile: 'custom:proj' })
    host.exit('t')
    // As after an app restart: a fresh shell of the same profile.
    await runner.startNode('t', { restored: true })
    expect(host.specs[1]).toMatchObject({ file: 'cmd.exe', args: ['/k', 'C:\\VS\\vcvars64.bat'] })
  })

  test('whose profile was deleted starts the default and says so in the window', async () => {
    const { runner, host, node } = setup([terminal({ profile: 'custom:gone' })], { terminalProfiles: [vs], defaultTerminalProfile: 'custom:vs' })
    await runner.startNode('t', { initialScrollback: 'old output\r\n' })
    expect(host.specs[0].file).toBe('cmd.exe')
    expect(host.specs[0].initialScrollback).toMatch(/^old output\r\n.*profile this window was opened with has been deleted, so it started with the default, VS prompt/)
    // It keeps its record, so it says so again rather than quietly becoming the default.
    expect(node().profile).toBe('custom:gone')
  })

  test('with no settings at all starts Git Bash --login -i, as before profiles', async () => {
    const { runner, host } = setup([terminal()], {})
    await runner.startNode('t')
    expect(host.specs[0]).toMatchObject({ file: GIT_BASH, args: ['--login', '-i'] })
    host.emit('t', PASTE_ON)
    expect(host.written).toEqual([])
  })

  test('SSH terminals are untouched by profiles', async () => {
    const store = memoryStore([terminal({ sshHost: 'build-box' })])
    const host = fakeHost()
    const runner = createNodeRunner({
      host,
      tracker: createStatusTracker({ notify: () => {} }),
      store,
      ctx: { sessionDir: 'C:/s', hookScript: 'h', pluginDir: 'p', cliDir: 'c', endpointFile: 'e', secret: 's', baseEnv: {}, settings: () => ({ terminalProfiles: [vs], defaultTerminalProfile: 'custom:vs' }), builtInProfiles: () => builtIns, ssh: () => 'C:\\ssh.exe' }
    })
    await runner.startNode('t')
    expect(host.specs[0].file).toBe('C:\\ssh.exe')
    expect((store.get().nodes[0] as TerminalNode).profile).toBeUndefined()
  })
})

describe('the startup typer', () => {
  test('types after any shell goes quiet, or after the longest wait for one that says nothing', async () => {
    const host = fakeHost()
    const typer = createStartupTyper({ host })
    await host.start({ nodeId: 'a', file: 'x', args: [], cwd: '', env: {} } as SessionSpec)
    await host.start({ nodeId: 'b', file: 'x', args: [], cwd: '', env: {} } as SessionSpec)
    typer.arm('a', ['one', 'two'])
    typer.arm('b', ['silent'])
    typer.output('a', 'PS C:\\> ')
    await vi.advanceTimersByTimeAsync(PROMPT_QUIET_MS + 1)
    expect(host.written).toEqual([['a', 'one\rtwo\r']])
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS)
    expect(host.written).toEqual([
      ['a', 'one\rtwo\r'],
      ['b', 'silent\r']
    ])
  })

  test('types nothing into a session that ended, and puts the guard prefix first', async () => {
    const host = fakeHost()
    const typer = createStartupTyper({ host, prefix: () => '\x00' })
    await host.start({ nodeId: 'a', file: 'x', args: [], cwd: '', env: {} } as SessionSpec)
    typer.arm('a', ['cd x'])
    typer.output('a', PASTE_ON)
    expect(host.written).toEqual([['a', '\x00cd x\r']])
    typer.arm('a', ['again'])
    host.exit('a')
    typer.cancel('a')
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS)
    expect(host.written).toHaveLength(1)
  })
})
