import { mkdtempSync } from 'node:fs'
import { constants, getPriority, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createSessionHost, SessionStartError } from '../../src/main/sessions/host'
import type { SessionHost, SessionSpec } from '../../src/shared/contract'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const CMD = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  nodeId: 'n',
  file: CMD,
  args: [],
  cwd: tmpdir(),
  env: process.env as Record<string, string>,
  ...over
})

const hosts: SessionHost[] = []
function host(opts?: { bufferBytes?: number }): SessionHost {
  const h = createSessionHost(opts)
  hosts.push(h)
  return h
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.kill('n')))
})

/** A cmd.exe that prints one marker and stays open, so a test can decide when it ends. */
const printing = (text: string): Partial<SessionSpec> => ({ args: ['/k', `echo ${text}`] })

test('start with a missing cwd throws SessionStartError cwd-missing', () => {
  const h = host()
  const missing = join(tmpdir(), 'patchbay-no-such-folder-' + process.pid)
  let thrown: unknown
  try {
    h.start(spec({ cwd: missing }))
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(SessionStartError)
  expect((thrown as SessionStartError).reason).toBe('cwd-missing')
  expect(h.isRunning('n')).toBe(false)
})

test('start with a cwd that is a file throws cwd-missing', () => {
  const h = host()
  expect(() => h.start(spec({ cwd: CMD }))).toThrowError(
    expect.objectContaining({ reason: 'cwd-missing' })
  )
})

test('start with a missing executable throws SessionStartError spawn-failed', () => {
  const h = host()
  expect(() => h.start(spec({ file: 'C:\\no\\such\\program.exe' }))).toThrowError(
    expect.objectContaining({ reason: 'spawn-failed' })
  )
  expect(h.isRunning('n')).toBe(false)
})

test('a real shell echoes input and fires onExit once when killed', async () => {
  const h = host()
  const exits: Array<[string, number]> = []
  h.onExit((id, code) => exits.push([id, code]))
  h.start(spec())
  expect(h.isRunning('n')).toBe(true)
  h.write('n', 'echo marker-%USERNAME%-end\r')
  await vi.waitFor(() => expect(h.snapshot('n').data).toMatch(/marker-[^%\r\n]+-end/), { timeout: 30_000 })

  await h.kill('n')
  await h.kill('n')
  expect(h.isRunning('n')).toBe(false)
  expect(exits).toHaveLength(1)
  expect(exits[0][0]).toBe('n')
})

test('a process that exits by itself fires onExit with its code and kill afterward is safe', async () => {
  const h = host()
  const exits: number[] = []
  h.onExit((_id, code) => exits.push(code))
  h.start(spec({ args: ['/c', 'exit 7'] }))
  await vi.waitFor(() => expect(exits).toEqual([7]), { timeout: 30_000 })
  expect(h.isRunning('n')).toBe(false)
  await h.kill('n')
  h.write('n', 'x')
  h.resize('n', 80, 24)
  expect(exits).toEqual([7])
})

test('snapshot plus later chunks loses and duplicates nothing', async () => {
  const h = host()
  const chunks: Array<[string, number]> = []
  h.onOutput((_id, data, seq) => chunks.push([data, seq]))
  h.start(spec(printing('first-mark')))
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('first-mark'), { timeout: 30_000 })

  const snap = h.snapshot('n')
  // Everything delivered up to the snapshot is exactly what the snapshot holds.
  expect(chunks.map(([d]) => d).join('')).toBe(snap.data)
  expect(chunks[chunks.length - 1][1]).toBe(snap.seq)

  const mark = chunks.length
  h.write('n', 'echo second-mark\r')
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('second-mark'), { timeout: 30_000 })
  const later = chunks.slice(mark)
  expect(later[0][1]).toBe(snap.seq + 1)
  later.forEach(([, seq], i) => expect(seq).toBe(snap.seq + 1 + i))
  expect(snap.data + later.map(([d]) => d).join('')).toBe(h.snapshot('n').data)
})

test('output is batched, not one onOutput call per pty chunk', async () => {
  const h = host()
  const chunks: string[] = []
  h.onOutput((_id, data) => chunks.push(data))
  // Prints 2000 lines as fast as cmd.exe can, then a marker. On a PC with every core busy cmd.exe can take minutes over
  // all of them, and batching shows long before: 400 lines are enough to judge it by.
  h.start(spec({ args: ['/d', '/s', '/c', '"(for /L %i in (1,1,2000) do @echo line-%i) & echo done-mark"'] }))
  const lines = (): number => chunks.join('').match(/line-\d+/g)?.length ?? 0
  await vi.waitFor(() => expect(chunks.join('').includes('done-mark') || lines() >= 400).toBe(true), { timeout: 120_000, interval: 50 })
  const seen = lines()
  // Fewer calls than lines: each call carries many of the pty's pieces, not one each.
  expect(chunks.length).toBeLessThan(seen)
  for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(64 * 1024)
}, 150_000)

test('initialScrollback seeds the buffer before the first output', async () => {
  const h = host()
  h.start(spec({ ...printing('fresh-mark'), initialScrollback: 'OLD-SCROLLBACK\r\n' }))
  expect(h.snapshot('n').data.startsWith('OLD-SCROLLBACK\r\n')).toBe(true)
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('fresh-mark'), { timeout: 30_000 })
  expect(h.snapshot('n').data.startsWith('OLD-SCROLLBACK\r\n')).toBe(true)
})

test('bufferBytes caps the scrollback', async () => {
  const h = host({ bufferBytes: 64 })
  h.start(spec({ ...printing('tail-mark'), initialScrollback: 'x'.repeat(500) }))
  expect(Buffer.byteLength(h.snapshot('n').data)).toBeLessThanOrEqual(64)
  await vi.waitFor(() => expect(h.snapshot('n').seq).toBeGreaterThan(0), { timeout: 30_000 })
  expect(Buffer.byteLength(h.snapshot('n').data)).toBeLessThanOrEqual(64)
})

test('a restarted session keeps counting seq upward, so an attached view never ignores it', async () => {
  const h = host()
  h.start(spec(printing('run-one')))
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('run-one'), { timeout: 30_000 })
  await h.kill('n')
  const before = h.snapshot('n')
  expect(before.data).toContain('run-one') // readable after exit, for saving
  const seqs: number[] = []
  h.onOutput((_id, _d, seq) => seqs.push(seq))
  h.start(spec(printing('run-two')))
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('run-two'), { timeout: 30_000 })
  expect(seqs[0]).toBe(before.seq + 1)
})

test('starting a node that is already running is refused and leaves it running', async () => {
  const h = host()
  h.start(spec())
  expect(() => h.start(spec())).toThrowError(expect.objectContaining({ reason: 'spawn-failed' }))
  expect(h.isRunning('n')).toBe(true)
})

test('a cwd with spaces works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay host space '))
  const h = host()
  try {
    h.start(spec({ cwd: dir, ...printing('in-space-mark') }))
    await vi.waitFor(() => expect(h.snapshot('n').data).toContain('in-space-mark'), { timeout: 30_000 })
    await h.kill('n')
  } finally {
    await removeTemp(dir)
  }
})

test('args for cmd.exe reach it verbatim, because cmd.exe has its own quoting', async () => {
  const h = host()
  h.start(spec({ args: ['/d', '/s', '/c', '"echo ^"a b^""'] }))
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('"a b"'), { timeout: 30_000 })
})

/**
 * Windows gives a new process its creator's priority class when that is below normal or idle. Run from inside a
 * Patchbay background session (as agents on the canvas run the suite), this test process is below normal itself, so
 * every session it starts is too, whatever the host does. Patchbay's own host runs at normal priority.
 */
const testRunsBelowNormal = getPriority() > constants.priority.PRIORITY_NORMAL
if (testRunsBelowNormal)
  console.warn('Skipping the session priority tests: this test process runs below normal priority (as in a Patchbay background session), and Windows passes that on to every process it starts.')

// Below normal already, every child would be below normal whatever the host did, so this would prove nothing.
test.skipIf(testRunsBelowNormal)('a background session runs below normal priority, and so does what it starts', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'pb-priority-')), 'child.txt')
  const h = host() as SessionHost & { start(s: SessionSpec): void }
  // The session starts a child of its own, which records its own priority, as an agent's tools would.
  const script = `const {spawnSync}=require('child_process');const r=spawnSync(process.execPath,['-e','console.log(require("os").getPriority())'],{encoding:'utf8'});require('fs').writeFileSync(${JSON.stringify(out)},r.stdout.trim());setInterval(()=>{},1000)`
  h.start(spec({ file: process.execPath, args: ['-e', `setTimeout(()=>{${script}},300)`], background: true }))
  const pid = h.pid('n') as number
  expect(getPriority(pid)).toBe(constants.priority.PRIORITY_BELOW_NORMAL)
  const { readFileSync, existsSync } = await import('node:fs')
  await vi.waitFor(() => expect(existsSync(out)).toBe(true), { timeout: 30_000 })
  expect(Number(readFileSync(out, 'utf8'))).toBe(constants.priority.PRIORITY_BELOW_NORMAL)
})

test.skipIf(testRunsBelowNormal)('any other session keeps normal priority', () => {
  const h = host() as SessionHost & { start(s: SessionSpec): void }
  h.start(spec({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }))
  expect(getPriority(h.pid('n') as number)).toBe(constants.priority.PRIORITY_NORMAL)
})
