import { afterEach, expect, test, vi } from 'vitest'
import type { IPty } from 'node-pty'
import type { KillReport, KillRoot } from '../../src/core/proc/safeKill'
import { endPty } from '../../src/main/sessions/ptyKill'

/** A pty as node-pty 1.1 builds it on Windows: kill() closes the console, then kills what the agent's list says. */
function conpty(opts: { dll?: boolean; conpty?: boolean } = {}) {
  const killedAfterClose: number[] = []
  const order: string[] = []
  const agent = {
    _useConpty: opts.conpty ?? true,
    _useConptyDll: opts.dll ?? false,
    // node-pty's own: lists after the close, and falls back to the shell's PID, which may be someone else's by then.
    _getConsoleProcessList: () => Promise.resolve([7001])
  }
  const proc = {
    pid: 7001,
    _agent: agent,
    kill: vi.fn(() => {
      order.push('kill')
      void agent._getConsoleProcessList().then((list) => killedAfterClose.push(...list))
    })
  }
  return { proc: proc as unknown as IPty, raw: proc, killedAfterClose, order }
}

const report = (over: Partial<KillReport> = {}): KillReport => ({ ok: true, killed: [], gone: [], skipped: [], listed: {}, ...over })

const flush = () => new Promise((r) => setTimeout(r, 0))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const onWindows = () => Object.defineProperty(process, 'platform', { value: 'win32' })
afterEach(() => Object.defineProperty(process, 'platform', platform))

test('the helper ends the shell and its console first, then node-pty closes the console and kills nothing by PID', async () => {
  onWindows()
  const p = conpty()
  const asked: KillRoot[][] = []
  const end = vi.fn(async (roots: KillRoot[]) => {
    asked.push(roots)
    p.order.push('helper')
    return report({ killed: [7002, 7003] })
  })
  expect(await endPty(p.proc, () => true, { end })).toBe(true)
  await flush()
  expect(p.order).toEqual(['helper', 'kill'])
  expect(asked).toEqual([[{ pid: 7001, bornBefore: expect.any(Number), console: true, tree: false }]])
  expect(p.killedAfterClose).toEqual([])
})

test('Stop on a run asks for the whole tree', async () => {
  onWindows()
  const p = conpty()
  const end = vi.fn(async () => report())
  await endPty(p.proc, () => true, { tree: true, end })
  expect(end).toHaveBeenCalledWith([expect.objectContaining({ pid: 7001, console: true, tree: true })])
})

test('a helper that fails or rejects kills nothing by PID: the console is still closed', async () => {
  onWindows()
  for (const end of [async () => report({ ok: false, error: 'no powershell' }), () => Promise.reject(new Error('no helper'))]) {
    const p = conpty()
    expect(await endPty(p.proc, () => true, { end })).toBe(true)
    await flush()
    expect(p.raw.kill).toHaveBeenCalledTimes(1)
    expect(p.killedAfterClose).toEqual([])
  }
})

test('a session that ended while the helper ran (by itself or by it) is not closed again', async () => {
  onWindows()
  const p = conpty()
  let running = true
  const told = await endPty(p.proc, () => running, {
    end: async () => {
      running = false
      return report({ killed: [7001] })
    }
  })
  expect(told).toBe(false)
  expect(p.raw.kill).not.toHaveBeenCalled()
})

test('asked twice, it ends once', async () => {
  onWindows()
  const p = conpty()
  const end = vi.fn(async () => report())
  const [a, b] = await Promise.all([endPty(p.proc, () => true, { end }), endPty(p.proc, () => true, { end })])
  expect([a, b]).toEqual([true, true])
  expect(end).toHaveBeenCalledTimes(1)
  expect(p.raw.kill).toHaveBeenCalledTimes(1)
})

test("winpty and conpty.dll: the helper first, then node-pty's own kill; other platforms: node-pty's kill alone", async () => {
  for (const make of [() => conpty({ conpty: false }), () => conpty({ dll: true })]) {
    onWindows()
    const p = make()
    const end = vi.fn(async () => report())
    expect(await endPty(p.proc, () => true, { end })).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
    expect(p.raw.kill).toHaveBeenCalledTimes(1)
  }
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const p = conpty()
  const end = vi.fn(async () => report())
  await endPty(p.proc, () => true, { end })
  expect(end).not.toHaveBeenCalled()
  expect(p.raw.kill).toHaveBeenCalledTimes(1)
})

test('a kill that throws (the process already gone) rejects, so the host can treat the session as ended', async () => {
  onWindows()
  const p = conpty()
  p.raw.kill.mockImplementation(() => {
    throw new Error('gone')
  })
  await expect(endPty(p.proc, () => true, { end: async () => report() })).rejects.toThrow('gone')
})
