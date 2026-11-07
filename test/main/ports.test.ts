import { expect, test, vi } from 'vitest'
import { createPortWatcher, matchPorts, parseNetstat, parseProcesses } from '../../src/main/ports/ports'

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       100
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       200
  TCP    127.0.0.1:50000        127.0.0.1:3000         ESTABLISHED     200
  TCP    [::]:5173              [::]:0                 LISTENING       100
  TCP    [::1]:8080             [::]:0                 LISTENING       300
  UDP    0.0.0.0:5353           *:*                                    400
`

test('parseNetstat keeps LISTENING over IPv4 and IPv6, once per port, and ignores other states', () => {
  expect(parseNetstat(NETSTAT)).toEqual([
    { port: 5173, pid: 100 },
    { port: 3000, pid: 200 },
    { port: 8080, pid: 300 }
  ])
})

test('parseNetstat survives a localized or garbled line', () => {
  expect(parseNetstat('  TCP    0.0.0.0:80   0.0.0.0:0   ABHÖREN   100\nnonsense\n  TCP x y LISTENING z\n')).toEqual([])
  expect(parseNetstat('')).toEqual([])
})

test('parseProcesses reads the list, and a single process that comes back as an object', () => {
  const list = JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, Name: 'a.exe' }, { ProcessId: 2, ParentProcessId: 1, Name: 'b.exe' }])
  expect(parseProcesses(list).get(2)).toEqual({ parent: 1, name: 'b.exe' })
  expect(parseProcesses(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: 'c.exe' })).get(5)?.name).toBe('c.exe')
  expect(parseProcesses('not json').size).toBe(0)
})

const processes = new Map([
  [10, { parent: 1, name: 'bash.exe' }],
  [11, { parent: 10, name: 'npm.exe' }],
  [12, { parent: 11, name: 'node.exe' }],
  [20, { parent: 1, name: 'cmd.exe' }],
  [99, { parent: 1, name: 'other.exe' }],
  [98, { parent: 1, name: 'Patchbay.exe' }]
])
const roots = new Map([
  [10, 'session-a'],
  [20, 'session-b']
])

test('a grandchild matches its session; an unrelated process and Patchbay itself do not', () => {
  const found = matchPorts(
    [
      { port: 5173, pid: 12 },
      { port: 9000, pid: 99 },
      { port: 7000, pid: 98 },
      { port: 4000, pid: 20 }
    ],
    processes,
    roots
  )
  expect(found).toEqual({ 'session-a': [{ port: 5173, name: 'node' }], 'session-b': [{ port: 4000, name: 'cmd' }] })
})

test('ports are listed in order', () => {
  const found = matchPorts(
    [
      { port: 9000, pid: 12 },
      { port: 3000, pid: 12 }
    ],
    processes,
    roots
  )
  expect(found['session-a'].map((p) => p.port)).toEqual([3000, 9000])
})

test('a loop in parent ids, as with a reused process id, ends instead of hanging', () => {
  const loop = new Map([
    [1, { parent: 2, name: 'a.exe' }],
    [2, { parent: 1, name: 'b.exe' }]
  ])
  expect(matchPorts([{ port: 80, pid: 1 }], loop, roots)).toEqual({})
})

test('a process with no known entry just does not match', () => {
  expect(matchPorts([{ port: 80, pid: 555 }], processes, roots)).toEqual({})
})

function setup(over: Partial<Parameters<typeof createPortWatcher>[0]> = {}) {
  const runNetstat = vi.fn(async () => '  TCP    0.0.0.0:5173   0.0.0.0:0   LISTENING   12\n')
  const runProcessList = vi.fn(async () => JSON.stringify([...processes].map(([ProcessId, p]) => ({ ProcessId, ParentProcessId: p.parent, Name: p.name }))))
  const watcher = createPortWatcher({ runNetstat, runProcessList, roots: () => roots, visible: () => true, ...over })
  return { watcher, runNetstat, runProcessList }
}

test('the process list is only fetched when the listening process ids change', async () => {
  const { watcher, runNetstat, runProcessList } = setup()
  await watcher.tick()
  await watcher.tick()
  expect(runNetstat).toHaveBeenCalledTimes(2)
  expect(runProcessList).toHaveBeenCalledTimes(1)
  expect(watcher.current()).toEqual({ 'session-a': [{ port: 5173, name: 'node' }] })
})

test('a new session root also refreshes the list', async () => {
  let current = new Map([[10, 'session-a']])
  const { watcher, runProcessList } = setup({ roots: () => current })
  await watcher.tick()
  current = new Map([
    [10, 'session-a'],
    [20, 'session-b']
  ])
  await watcher.tick()
  expect(runProcessList).toHaveBeenCalledTimes(2)
})

test('nothing runs while the window is hidden', async () => {
  const { watcher, runNetstat } = setup({ visible: () => false })
  await watcher.tick()
  expect(runNetstat).not.toHaveBeenCalled()
})

test('a failed netstat keeps the last result', async () => {
  let fail = false
  const { watcher } = setup({
    runNetstat: async () => {
      if (fail) throw new Error('no')
      return '  TCP    0.0.0.0:5173   0.0.0.0:0   LISTENING   12\n'
    }
  })
  await watcher.tick()
  fail = true
  await watcher.tick()
  expect(watcher.current()['session-a']).toHaveLength(1)
})

test('ticks do not overlap', async () => {
  let release = (): void => {}
  const runNetstat = vi.fn(() => new Promise<string>((r) => (release = () => r(''))))
  const { watcher } = setup({ runNetstat })
  const first = watcher.tick()
  const second = watcher.tick()
  release()
  await Promise.all([first, second])
  expect(runNetstat).toHaveBeenCalledTimes(1)
})

test('listeners hear a change, and not an unchanged result', async () => {
  const { watcher } = setup()
  const changed = vi.fn()
  watcher.onChange(changed)
  await watcher.tick()
  await watcher.tick()
  expect(changed).toHaveBeenCalledTimes(1)
})

test('a stopped server drops its port', async () => {
  let text = '  TCP    0.0.0.0:5173   0.0.0.0:0   LISTENING   12\n'
  const { watcher } = setup({ runNetstat: async () => text })
  await watcher.tick()
  text = ''
  await watcher.tick()
  expect(watcher.current()).toEqual({})
})

test('canOpen is true only for a port currently listed for that node', async () => {
  const { watcher } = setup()
  await watcher.tick()
  expect(watcher.canOpen('session-a', 5173)).toBe(true)
  expect(watcher.canOpen('session-b', 5173)).toBe(false)
  expect(watcher.canOpen('session-a', 22)).toBe(false)
})

test('a server whose parent chain is broken still matches through the session console', async () => {
  // As under Git Bash: node, winpty-agent, winpty, then a parent that has already exited.
  const list = [
    { ProcessId: 12, ParentProcessId: 11, Name: 'node.exe' },
    { ProcessId: 11, ParentProcessId: 10, Name: 'winpty-agent.exe' },
    { ProcessId: 10, ParentProcessId: 777, Name: 'winpty.exe' }
  ]
  const consoleMembers = vi.fn(async (root: number) => (root === 500 ? [500, 10] : []))
  const { watcher } = setup({ roots: () => new Map([[500, 'session-a']]), runProcessList: async () => JSON.stringify(list), consoleMembers })
  await watcher.tick()
  expect(watcher.current()).toEqual({ 'session-a': [{ port: 5173, name: 'node' }] })
  expect(consoleMembers).toHaveBeenCalledWith(500)
})

test('a console that cannot be read just leaves the parent walk', async () => {
  const { watcher } = setup({
    consoleMembers: async () => {
      throw new Error('AttachConsole failed')
    }
  })
  await watcher.tick()
  expect(watcher.current()).toEqual({ 'session-a': [{ port: 5173, name: 'node' }] })
})

test('consoles are only read when the listening process ids change', async () => {
  const consoleMembers = vi.fn(async () => [])
  const { watcher } = setup({ consoleMembers })
  await watcher.tick()
  await watcher.tick()
  expect(consoleMembers).toHaveBeenCalledTimes(2)
})
