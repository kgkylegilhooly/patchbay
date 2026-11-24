import { expect, test, vi } from 'vitest'
import { hasExited, killTree, type Killable } from '../../src/core/proc/killTree'
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

test('a running child gets its whole tree ended (taskkill /T on Windows)', () => {
  const on = vi.fn()
  const start = vi.fn(() => ({ on }))
  const live = child()
  expect(killTree(live, start as never)).toBe(true)
  if (process.platform === 'win32') expect(start).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.anything())
  else expect(live.kill).toHaveBeenCalledWith('SIGKILL')
})

test('a real program past its time limit is stopped and the run settles', async () => {
  const r = await runHere(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env as Record<string, string>, timeoutMs: 300, maxBytes: 1024 })
  expect(r.timedOut).toBe(true)
})
