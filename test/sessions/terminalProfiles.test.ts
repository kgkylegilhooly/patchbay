import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { createNodeRunner, type NodeRunnerContext } from '../../src/main/sessions/nodeRunner'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { createSendGuard, type SendGuard } from '../../src/main/sessions/sendGuard'
import { createStartupTyper, looksLikePrompt, PROMPT_QUIET_MS, PROMPT_WAIT_MAX_MS, STARTUP_WAITING } from '../../src/main/sessions/terminalStart'
import type { CanvasStore, SessionHost, SessionSpec } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, TerminalNode } from '../../src/shared/model'
import { SACRIFICE } from '../../src/shared/resizeGuard'
import type { Settings } from '../../src/shared/settings'
import { builtInProfiles, GIT_BASH, type TerminalProfile } from '../../src/shared/terminalProfiles'

const PASTE_ON = '\x1b[?2004h'
/** Bash's sign is acted on once every listener has had the chunk. */
const flush = () => vi.advanceTimersByTimeAsync(0)

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
const builtIns = builtInProfiles({ gitBash: true, wsl: true })

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

  test("a cmd profile's spaced path reaches cmd quoted, in the line the host builds", async () => {
    const spaced: TerminalProfile = { ...vs, args: ['/k', 'C:\\Program Files (x86)\\VS\\vcvars64.bat'] }
    const { runner, host } = setup([terminal({ profile: 'custom:vs' })], { terminalProfiles: [spaced] })
    await runner.startNode('t')
    expect(host.specs[0].args.join(' ')).toBe('/k ""C:\\Program Files (x86)\\VS\\vcvars64.bat""')
  })

  test('types its startup command once, when bash says its prompt is ready, and never blind', async () => {
    const { runner, host } = setup([terminal({ profile: 'custom:proj' })], { terminalProfiles: [vs, proj] })
    await runner.startNode('t')
    // A login script asking for a passphrase: quiet, and no sign. Nothing is typed into it, and the node says why.
    host.emit('t', 'Enter passphrase for /c/Users/me/.ssh/id_ed25519: ')
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS + 1)
    expect(host.written).toEqual([])
    expect(runner.errors().t?.message).toBe(STARTUP_WAITING)
    // The person answers it, which doesn't cancel anything, and bash reaches its prompt.
    runner.noteInput('t', 'secret\r')
    host.emit('t', `\r\n${PASTE_ON}$ `)
    await flush()
    expect(host.written).toEqual([['t', 'cd ~/proj && nvm use\r']])
    expect(runner.errors().t).toBeUndefined()
    host.emit('t', `${PASTE_ON}$ `)
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS)
    expect(host.written).toHaveLength(1)
  })

  test("types the node's own command after the startup command, and only the startup command on restore", async () => {
    const t = setup([terminal({ profile: 'custom:proj', command: 'npm test' })], { terminalProfiles: [vs, proj] })
    await t.runner.startNode('t')
    t.host.emit('t', PASTE_ON)
    await flush()
    expect(t.host.written).toEqual([['t', 'cd ~/proj && nvm use\rnpm test\r']])

    const r = setup([terminal({ profile: 'custom:proj', command: 'npm run deploy' })], { terminalProfiles: [vs, proj] })
    await r.runner.startNode('t', { restored: true })
    r.host.emit('t', PASTE_ON)
    await flush()
    expect(r.host.written).toEqual([['t', 'cd ~/proj && nvm use\r']])
  })

  test("WSL waits for bash's sign too, so a new distro's questions get nothing typed", async () => {
    const { runner, host } = setup([terminal({ profile: 'builtin:wsl', command: 'make' })], {})
    await runner.startNode('t')
    expect(host.specs[0]).toMatchObject({ file: 'wsl.exe', args: [] })
    host.emit('t', 'Enter new UNIX username: ')
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS + 1)
    expect(host.written).toEqual([])
    host.emit('t', `${PASTE_ON}me@box:~$ `)
    await flush()
    expect(host.written).toEqual([['t', 'make\r']])
  })

  test('a PowerShell or cmd profile types at a quiet prompt, and stands aside if the person types first', async () => {
    const pw: TerminalProfile = { id: 'custom:pw', name: 'PS', program: 'pwsh.exe', args: ['-NoLogo'], startupCommand: 'Import-Module x' }
    const t = setup([terminal({ profile: 'custom:pw' })], { terminalProfiles: [pw] })
    await t.runner.startNode('t')
    t.host.emit('t', 'Loading profile...\r\n')
    await vi.advanceTimersByTimeAsync(PROMPT_QUIET_MS * 2)
    expect(t.host.written).toEqual([])
    t.host.emit('t', 'PS C:\\work> ')
    await vi.advanceTimersByTimeAsync(PROMPT_QUIET_MS + 1)
    expect(t.host.written).toEqual([['t', 'Import-Module x\r']])

    const u = setup([terminal({ profile: 'custom:pw' })], { terminalProfiles: [pw] })
    await u.runner.startNode('t')
    // The terminal answering a question isn't typing.
    u.runner.noteInput('t', '\x1b[?1;2c')
    u.runner.noteInput('t', 'g')
    u.host.emit('t', 'PS C:\\work> g')
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS + 1)
    expect(u.host.written).toEqual([])
    expect(u.runner.errors().t?.message).toMatch(/wasn't typed, because you typed first: Import-Module x/)
  })

  test('a Git Bash startup command gets the send guard byte when the window resized first', async () => {
    const store = memoryStore([terminal({ profile: 'custom:proj' })])
    const host = fakeHost()
    let guard: SendGuard | undefined
    const ctx: NodeRunnerContext = {
      sessionDir: 'C:/s', hookScript: 'h', pluginDir: 'p', cliDir: 'c', endpointFile: 'e', secret: 's', baseEnv: {},
      settings: () => ({ terminalProfiles: [proj] }),
      builtInProfiles: () => builtIns,
      typePrefix: (id) => guard!.prefixFor(id)
    }
    const runner = createNodeRunner({ host, tracker: createStatusTracker({ notify: () => {} }), store, ctx })
    // As in the app: the guard hears output after the runner does.
    guard = createSendGuard({ isGitBash: () => true })
    host.onOutput((id, data) => guard!.output(id, data))
    await runner.startNode('t')
    guard.resized('t')
    host.emit('t', `${PASTE_ON}$ `)
    await flush()
    expect(host.written).toEqual([['t', `${SACRIFICE}cd ~/proj && nvm use\r`]])
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

  test('whose profile was deleted starts the default and says so on the node, not in its saved output', async () => {
    const { runner, host, node } = setup([terminal({ profile: 'custom:gone' })], { terminalProfiles: [vs], defaultTerminalProfile: 'custom:vs' })
    await runner.startNode('t', { initialScrollback: 'old output\r\n' })
    expect(host.specs[0].file).toBe('cmd.exe')
    expect(host.specs[0].initialScrollback).toBe('old output\r\n')
    expect(runner.errors().t?.message).toBe('The terminal profile this window was opened with has been deleted, so it started with the default, VS prompt.')
    // It keeps its record, so it says so again rather than quietly becoming the default.
    expect(node().profile).toBe('custom:gone')
    host.exit('t')
    await runner.startNode('t', { initialScrollback: 'old output\r\n' })
    expect(host.specs[1].initialScrollback).toBe('old output\r\n')
  })

  test('with no settings at all starts Git Bash --login -i, as before profiles', async () => {
    const { runner, host } = setup([terminal()], {})
    await runner.startNode('t')
    expect(host.specs[0]).toMatchObject({ file: GIT_BASH, args: ['--login', '-i'] })
    host.emit('t', PASTE_ON)
    await flush()
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
  const start = (host: ReturnType<typeof fakeHost>, id: string) => host.start({ nodeId: id, file: 'x', args: [], cwd: '', env: {} } as SessionSpec)

  test("in 'prompt' mode, types at a quiet prompt-looking line; a password question or silence gets nothing typed", async () => {
    const host = fakeHost()
    const waited: string[] = []
    const typer = createStartupTyper({ host, events: { waiting: (id) => waited.push(id) } })
    for (const id of ['a', 'b', 'c']) await start(host, id)
    typer.arm('a', ['one', 'two'], 'prompt')
    typer.arm('b', ['silent'], 'prompt')
    typer.arm('c', ['ls'], 'prompt')
    typer.output('a', 'PS C:\\> ')
    typer.output('c', "me@host's password: ")
    await vi.advanceTimersByTimeAsync(PROMPT_QUIET_MS + 1)
    expect(host.written).toEqual([['a', 'one\rtwo\r']])
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS)
    expect(host.written).toHaveLength(1)
    expect(waited.sort()).toEqual(['b', 'c'])
    // Still waiting: a prompt that turns up late gets them.
    typer.output('b', 'C:\\work>')
    await vi.advanceTimersByTimeAsync(PROMPT_QUIET_MS + 1)
    expect(host.written.at(-1)).toEqual(['b', 'silent\r'])
  })

  test("bash's sign is found when it arrives split across two chunks", async () => {
    const host = fakeHost()
    const typer = createStartupTyper({ host })
    await start(host, 'a')
    typer.arm('a', ['cd x'], 'sign')
    typer.output('a', 'motd\r\n\x1b[?20')
    typer.output('a', '04h$ ')
    await flush()
    expect(host.written).toEqual([['a', 'cd x\r']])
  })

  test('types nothing into a session that ended, and puts the guard prefix first', async () => {
    const host = fakeHost()
    const typer = createStartupTyper({ host, prefix: () => '\x00' })
    await start(host, 'a')
    typer.arm('a', ['cd x'], 'sign')
    typer.output('a', PASTE_ON)
    await flush()
    expect(host.written).toEqual([['a', '\x00cd x\r']])
    typer.arm('a', ['again'], 'sign')
    host.exit('a')
    typer.cancel('a')
    typer.output('a', PASTE_ON)
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MAX_MS)
    expect(host.written).toHaveLength(1)
  })

  test('looksLikePrompt reads only the last line', () => {
    expect(looksLikePrompt('banner\r\nPS C:\\> ')).toBe(true)
    expect(looksLikePrompt('C:\\work>')).toBe(true)
    expect(looksLikePrompt('\x1b[32mme@box\x1b[0m:~$ ')).toBe(true)
    expect(looksLikePrompt('C:\\work>\r\nPassword: ')).toBe(false)
    expect(looksLikePrompt('Continue? [Y/n] ')).toBe(false)
  })
})
