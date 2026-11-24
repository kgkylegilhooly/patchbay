import { afterEach, expect, test, vi } from 'vitest'
import type { IPty } from 'node-pty'
import type { KillReport, KillRoot } from '../../src/core/proc/safeKill'
import { endPty, releaseConsole } from '../../src/main/sessions/ptyKill'

/** A pty as node-pty 1.1 builds it on Windows: kill() closes the console, then kills what the agent's list says. */
function conpty(opts: { dll?: boolean; conpty?: boolean } = {}) {
  const killedAfterClose: number[] = []
  const order: string[] = []
  const inSocket = { destroy: vi.fn() }
  const agent = {
    _useConpty: opts.conpty ?? true,
    _useConptyDll: opts.dll ?? false,
    _inSocket: inSocket,
    // node-pty's own: lists after the close, and falls back to the shell's PID, which may be someone else's by then.
    _getConsoleProcessList: () => Promise.resolve([7001])
  }
  const proc = {
    pid: 7001,
    _agent: agent,
    kill: vi.fn(() => {
      order.push('close')
      void agent._getConsoleProcessList().then((list) => killedAfterClose.push(...list))
    })
  }
  return { proc: proc as unknown as IPty, raw: proc, killedAfterClose, order, inSocket }
}

const report = (over: Partial<KillReport> = {}): KillReport => ({ ok: true, killed: [], gone: [], kept: [], skipped: [], listed: {}, ...over })

const flush = () => new Promise((r) => setTimeout(r, 0))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const onWindows = () => Object.defineProperty(process, 'platform', { value: 'win32' })
afterEach(() => Object.defineProperty(process, 'platform', platform))

test('the helper holds the shell and ends the rest of its console; then node-pty closes the console, killing nothing by PID', async () => {
  onWindows()
  const p = conpty()
  const asked: KillRoot[][] = []
  const end = vi.fn(async (roots: KillRoot[]) => {
    asked.push(roots)
    p.order.push('helper')
    return report({ killed: [7002], kept: [7001] })
  })
  expect(await endPty(p.proc, () => true, { end, born: { after: 100, before: 200 } })).toBe(true)
  await flush()
  // The close comes after, while the shell still runs: it ends the shell, what's left on the console, and conhost.exe.
  expect(p.order).toEqual(['helper', 'close'])
  expect(asked[0]).toEqual([{ pid: 7001, bornBefore: 200, bornAfter: 100, console: true, tree: false, keep: true }])
  expect(p.killedAfterClose).toEqual([])
})

test('Stop on a run asks for the whole tree', async () => {
  onWindows()
  const p = conpty()
  const end = vi.fn(async () => report({ kept: [7001] }))
  await endPty(p.proc, () => true, { tree: true, end })
  expect(end).toHaveBeenCalledWith([expect.objectContaining({ pid: 7001, console: true, tree: true, keep: true })])
})

test('a shell that ignores the close is ended by the helper after a moment, by the same proof; one that ends is not', async () => {
  onWindows()
  const stubborn = conpty()
  const end = vi.fn(async () => report({ kept: [7001] }))
  await endPty(stubborn.proc, () => true, { end, graceMs: 5, born: { after: 100, before: 200 } })
  await new Promise((r) => setTimeout(r, 30))
  expect(end).toHaveBeenCalledTimes(2)
  expect(end).toHaveBeenLastCalledWith([{ pid: 7001, bornBefore: 200, bornAfter: 100 }])

  const polite = conpty()
  let running = true
  const end2 = vi.fn(async () => report({ kept: [7001] }))
  polite.raw.kill.mockImplementation(() => {
    running = false
  })
  await endPty(polite.proc, () => running, { end: end2, graceMs: 5 })
  await new Promise((r) => setTimeout(r, 30))
  expect(end2).toHaveBeenCalledTimes(1)
})

test('a shell the helper could not prove is closed by node-pty, and never killed after', async () => {
  onWindows()
  const p = conpty()
  const end = vi.fn(async () => report({ skipped: [{ pid: 7001, why: 'not-ours' }] }))
  await endPty(p.proc, () => true, { end, graceMs: 5 })
  await new Promise((r) => setTimeout(r, 30))
  expect(p.raw.kill).toHaveBeenCalledTimes(1)
  expect(end).toHaveBeenCalledTimes(1)
})

test("when the helper can't run, round 4's way: the console listed first and handed to node-pty", async () => {
  onWindows()
  for (const end of [async () => report({ ok: false, error: 'blocked' }), () => Promise.reject(new Error('no helper'))]) {
    const p = conpty()
    const list = vi.fn(async (pid: number) => {
      p.order.push(`list ${pid}`)
      return [7001, 7002]
    })
    expect(await endPty(p.proc, () => true, { end, list })).toBe(true)
    await flush()
    expect(p.order).toEqual(['list 7001', 'close'])
    expect(p.killedAfterClose).toEqual([7001, 7002])
  }
})

test("when the helper can't run, a tree is ended with taskkill /T as round 4 did, the shell only while it runs", async () => {
  onWindows()
  const p = conpty()
  const taskkill = vi.fn(async (_pid: number) => {})
  await endPty(p.proc, () => true, { tree: true, end: async () => report({ ok: false }), list: async () => [7002, 7003], taskkill })
  expect(taskkill.mock.calls.map(([pid]) => pid).sort()).toEqual([7001, 7002, 7003])
  expect(p.raw.kill).toHaveBeenCalledTimes(1)
})

test('a session that ended while the helper ran (as its children were ended, say) is not closed again', async () => {
  onWindows()
  const p = conpty()
  let running = true
  const told = await endPty(p.proc, () => running, {
    end: async () => {
      running = false
      return report({ kept: [7001] })
    }
  })
  expect(told).toBe(false)
  expect(p.raw.kill).not.toHaveBeenCalled()
})

test('a console whose shell has ended is let go by closing its input, which ends its console host (in-box ConPTY only)', () => {
  onWindows()
  const p = conpty()
  releaseConsole(p.proc)
  expect(p.inSocket.destroy).toHaveBeenCalledTimes(1)
  const dll = conpty({ dll: true })
  releaseConsole(dll.proc)
  expect(dll.inSocket.destroy).not.toHaveBeenCalled()
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

test("other platforms: node-pty's kill alone", async () => {
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
