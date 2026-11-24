import { afterEach, expect, test, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { endPty } from '../../src/main/sessions/ptyKill'

/** A pty as node-pty 1.1 builds it on Windows: kill() closes the console, then kills what the agent's list says. */
function conpty(opts: { dll?: boolean; conpty?: boolean } = {}) {
  const killedAfterClose: number[] = []
  const order: string[] = []
  const agent = {
    _useConpty: opts.conpty ?? true,
    _useConptyDll: opts.dll ?? false,
    _innerPid: 7001,
    // node-pty's own: lists after the close, and falls back to the shell's PID, which may be someone else's by then.
    _getConsoleProcessList: () => Promise.resolve([7001])
  }
  const proc = {
    _agent: agent,
    kill: vi.fn(() => {
      order.push('kill')
      void agent._getConsoleProcessList().then((list) => killedAfterClose.push(...list))
    })
  }
  return { proc: proc as unknown as IPty, raw: proc, killedAfterClose, order }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const onWindows = () => Object.defineProperty(process, 'platform', { value: 'win32' })
afterEach(() => Object.defineProperty(process, 'platform', platform))

test('the console is listed before it is closed, and node-pty kills exactly that list', async () => {
  onWindows()
  const p = conpty()
  const list = vi.fn(async (pid: number) => {
    p.order.push(`list ${pid}`)
    return [7001, 7002, 7003]
  })
  expect(await endPty(p.proc, () => true, list)).toBe(true)
  await flush()
  expect(p.order).toEqual(['list 7001', 'kill'])
  expect(p.killedAfterClose).toEqual([7001, 7002, 7003])
})

test("a list that fails kills nothing more than the close does: never the shell's PID on its own", async () => {
  onWindows()
  const p = conpty()
  expect(await endPty(p.proc, () => true, async () => [])).toBe(true)
  await flush()
  expect(p.raw.kill).toHaveBeenCalledTimes(1)
  expect(p.killedAfterClose).toEqual([])
  const q = conpty()
  expect(await endPty(q.proc, () => true, () => Promise.reject(new Error('no helper')))).toBe(true)
  await flush()
  expect(q.killedAfterClose).toEqual([])
})

test('a session that ended by itself while it was listed is not killed', async () => {
  onWindows()
  const p = conpty()
  let running = true
  const told = await endPty(p.proc, () => running, async () => {
    running = false
    return [7001]
  })
  expect(told).toBe(false)
  expect(p.raw.kill).not.toHaveBeenCalled()
})

test('asked twice, it lists and kills once', async () => {
  onWindows()
  const p = conpty()
  const list = vi.fn(async () => [7001])
  const [a, b] = await Promise.all([endPty(p.proc, () => true, list), endPty(p.proc, () => true, list)])
  expect([a, b]).toEqual([true, true])
  expect(list).toHaveBeenCalledTimes(1)
  expect(p.raw.kill).toHaveBeenCalledTimes(1)
})

test('winpty, conpty.dll and other platforms keep node-pty\'s own kill, which is safe there', async () => {
  for (const make of [() => conpty({ conpty: false }), () => conpty({ dll: true })]) {
    onWindows()
    const p = make()
    const list = vi.fn(async () => [1])
    expect(await endPty(p.proc, () => true, list)).toBe(true)
    expect(list).not.toHaveBeenCalled()
    expect(p.raw.kill).toHaveBeenCalledTimes(1)
  }
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const p = conpty()
  const list = vi.fn(async () => [1])
  await endPty(p.proc, () => true, list)
  expect(list).not.toHaveBeenCalled()
})

test('a kill that throws (the process already gone) rejects, so the host can treat the session as ended', async () => {
  onWindows()
  const p = conpty()
  p.raw.kill.mockImplementation(() => {
    throw new Error('gone')
  })
  await expect(endPty(p.proc, () => true, async () => [])).rejects.toThrow('gone')
})
