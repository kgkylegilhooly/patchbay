import { expect, test, vi } from 'vitest'
import { hasExited, killTree, type Killable } from '../../src/core/proc/killTree'
import type { KillReport } from '../../src/core/proc/safeKill'
import { runHere } from '../../src/core/git/run'
import { usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const child = (over: Partial<Killable> = {}): Killable & { kill: ReturnType<typeof vi.fn> } => ({
  pid: 4242,
  exitCode: null,
  signalCode: null,
  kill: vi.fn(() => true),
  stdout: { destroy: vi.fn() },
  stderr: { destroy: vi.fn() },
  ...over
}) as Killable & { kill: ReturnType<typeof vi.fn> }

test('a child whose exit has been seen is never killed by its PID, which may be another process by now', () => {
  const start = vi.fn()
  for (const gone of [child({ exitCode: 0 }), child({ exitCode: 1 }), child({ signalCode: 'SIGTERM' })]) {
    expect(hasExited(gone)).toBe(true)
    expect(killTree(gone, start as never)).toBe(false)
    expect(gone.kill).not.toHaveBeenCalled()
    // Its pipes, still held by something it started, are closed so a wait for "close" ends.
    expect(gone.stdout!.destroy).toHaveBeenCalled()
    expect(gone.stderr!.destroy).toHaveBeenCalled()
  }
  expect(start).not.toHaveBeenCalled()
})

const report = (over: Partial<KillReport> = {}): KillReport => ({ ok: true, killed: [], gone: [], kept: [], skipped: [], listed: {}, ...over })
const flush = () => new Promise((r) => setTimeout(r, 0))

test('a running child gets its whole tree ended, on Windows by the helper that proves each process ours', async () => {
  const end = vi.fn(async () => report({ killed: [4242, 5000] }))
  const live = child()
  expect(killTree(live, end)).toBe(true)
  await flush()
  if (process.platform === 'win32') {
    expect(end).toHaveBeenCalledWith([{ pid: 4242, bornBefore: expect.any(Number), tree: true }])
    expect(live.kill).not.toHaveBeenCalled()
  } else expect(live.kill).toHaveBeenCalledWith('SIGKILL')
})

test.skipIf(process.platform !== 'win32')("a helper that can't run falls back to round 4's taskkill /T, while the exit is unseen", async () => {
  for (const end of [async () => report({ ok: false, error: 'blocked' }), () => Promise.reject(new Error('no helper'))]) {
    const start = vi.fn(() => ({ on: vi.fn() }))
    const live = child()
    killTree(live, end, start as never)
    await flush()
    expect(start).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.anything())
    expect(live.kill).not.toHaveBeenCalled()
  }
})

test.skipIf(process.platform !== 'win32')("a child the helper ran for but couldn't prove is ended through Node's own handle; one that exited meanwhile, not at all", async () => {
  const start = vi.fn()
  const young = child()
  killTree(young, async () => report({ skipped: [{ pid: 4242, why: 'not-ours' }] }), start as never)
  await flush()
  expect(young.kill).toHaveBeenCalledWith('SIGKILL')
  // Exited meanwhile: Node has let its handle go, so nothing more.
  const ended = child()
  killTree(ended, async () => {
    ended.exitCode = 0
    return report({ ok: false })
  }, start as never)
  await flush()
  expect(ended.kill).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

test('a real program past its time limit is stopped and the run settles', async () => {
  const r = await runHere(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env as Record<string, string>, timeoutMs: 300, maxBytes: 1024 })
  expect(r.timedOut).toBe(true)
})
