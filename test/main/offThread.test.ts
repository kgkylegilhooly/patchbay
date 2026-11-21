import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, test, vi } from 'vitest'
import { runHere, runProgram, useProgramRunner, type RunResult } from '../../src/core/git/run'
import { ANSWER_GRACE_MS, CRASHES_BEFORE_GIVING_UP, offThreadRunner, READY_MS, STOPPED_WHILE_RUNNING, type FromWorker, type ToWorker, type WorkerLike } from '../../src/main/proc/offThread'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', truncated: false, timedOut: false, missing: false })
const opts = { env: {}, timeoutMs: 1000, maxBytes: 1024 }

/** A worker that answers only when told to. */
class FakeWorker extends EventEmitter implements WorkerLike {
  sent: ToWorker[] = []
  terminated = false
  postMessage(m: ToWorker): void {
    this.sent.push(m)
  }
  ready(): void {
    this.emit('message', { ready: true } satisfies FromWorker)
  }
  answer(id: number, stdout: string): void {
    this.emit('message', { id, result: ok(stdout) } satisfies FromWorker)
  }
  terminate(): void {
    this.terminated = true
  }
}

function setup() {
  const workers: FakeWorker[] = []
  const fallback = vi.fn(async (file: string) => ok(`here:${file}`))
  const log = vi.fn()
  const run = offThreadRunner({
    start: () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    },
    fallback,
    log
  })
  return { run, workers, fallback, log }
}

afterEach(() => useProgramRunner(null))

test('programs asked for before the worker is ready wait for it, then go to it in order', async () => {
  const { run, workers, fallback } = setup()
  const a = run('git', ['status'], opts)
  const b = run('git', ['log'], opts)
  expect(workers).toHaveLength(1)
  expect(workers[0].sent).toHaveLength(0)
  workers[0].ready()
  expect(workers[0].sent.map((m) => m.args[0])).toEqual(['status', 'log'])
  workers[0].answer(workers[0].sent[1].id, 'second')
  workers[0].answer(workers[0].sent[0].id, 'first')
  expect((await a).stdout).toBe('first')
  expect((await b).stdout).toBe('second')
  expect(fallback).not.toHaveBeenCalled()
  // One worker serves every later program.
  void run('git', ['diff'], opts)
  expect(workers).toHaveLength(1)
  expect(workers[0].sent).toHaveLength(3)
})

test("a worker that can't start runs what was waiting here, and everything after", async () => {
  const { run, workers, fallback, log } = setup()
  const a = run('git', ['status'], opts)
  workers[0].emit('error', new Error('Cannot find module procWorker.js'))
  expect((await a).stdout).toBe('here:git')
  expect(run.gaveUp).toBe(true)
  expect((await run('netstat', ['-ano'], opts)).stdout).toBe('here:netstat')
  expect(workers).toHaveLength(1)
  expect(fallback).toHaveBeenCalledTimes(2)
  expect(log.mock.calls[0][0]).toMatch(/couldn't start/)
})

test('a start that throws runs the program here', async () => {
  const fallback = vi.fn(async () => ok('here'))
  const run = offThreadRunner({ start: () => { throw new Error('no threads') }, fallback })
  expect((await run('git', [], opts)).stdout).toBe('here')
  expect(run.gaveUp).toBe(true)
})

test('a worker that stops mid-run fails what had started, never runs it twice, and a new worker takes the next', async () => {
  const { run, workers, fallback } = setup()
  const a = run('git', ['commit'], opts)
  workers[0].ready()
  workers[0].emit('exit', 1)
  const r = await a
  expect(r.code).toBeNull()
  expect(r.stderr).toBe(STOPPED_WHILE_RUNNING)
  expect(fallback).not.toHaveBeenCalled()
  const b = run('git', ['status'], opts)
  expect(workers).toHaveLength(2)
  workers[1].ready()
  workers[1].answer(workers[1].sent[0].id, 'fine')
  expect((await b).stdout).toBe('fine')
  expect(run.gaveUp).toBe(false)
})

test('a worker that keeps stopping is given up on', async () => {
  const { run, workers, log } = setup()
  for (let i = 0; i < CRASHES_BEFORE_GIVING_UP; i++) {
    const p = run('git', [], opts)
    workers[i].ready()
    workers[i].emit('exit', 1)
    await p
  }
  expect(run.gaveUp).toBe(true)
  expect((await run('git', [], opts)).stdout).toBe('here:git')
  expect(log.mock.calls.at(-1)?.[0]).toMatch(/stopped 3 times/)
})

test('an answer from a worker that was replaced is ignored', async () => {
  const { run, workers } = setup()
  const a = run('git', [], opts)
  const old = workers[0]
  old.ready()
  const id = old.sent[0].id
  old.emit('exit', 1)
  await a
  const b = run('git', [], opts)
  workers[1].ready()
  old.answer(id, 'stale')
  workers[1].answer(workers[1].sent[0].id, 'fresh')
  expect((await b).stdout).toBe('fresh')
})

test('close ends the worker and later programs run here', async () => {
  const { run, workers } = setup()
  void run('git', [], opts)
  run.close()
  expect(workers[0].terminated).toBe(true)
  expect((await run('git', ['x'], opts)).stdout).toBe('here:git')
})

test('runProgram goes through the runner that was set, and back to this thread when cleared', async () => {
  const runner = vi.fn(async () => ok('elsewhere'))
  useProgramRunner(runner)
  expect((await runProgram('git', ['status'], opts)).stdout).toBe('elsewhere')
  expect(runner).toHaveBeenCalledWith('git', ['status'], opts)
  useProgramRunner(null)
  const r = await runProgram('a-program-that-does-not-exist-pb', [], opts)
  expect(r.missing).toBe(true)
})

test('a real worker thread runs a real program and keeps the calling thread free while processes start', async () => {
  // The worker's own code, as electron-vite would build it, in plain JavaScript over runHere's contract.
  const source = `
    const { parentPort } = require('node:worker_threads')
    const { spawn } = require('node:child_process')
    parentPort.on('message', (m) => {
      const c = spawn(m.file, m.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      c.stdout.on('data', (d) => (out += d))
      c.on('close', (code) => parentPort.postMessage({ id: m.id, result: { code, stdout: out, stderr: '', truncated: false, timedOut: false, missing: false } }))
    })
    parentPort.postMessage({ ready: true })`
  const run = offThreadRunner({ start: () => new Worker(source, { eval: true }) as unknown as WorkerLike, fallback: runHere })
  try {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("hi")'], opts)
    expect(r).toMatchObject({ code: 0, stdout: 'hi' })
    expect(run.gaveUp).toBe(false)
  } finally {
    run.close()
  }
}, 20_000)

test('mapFew runs at most the limit at once and keeps the order of results', async () => {
  const { mapFew } = await import('../../src/main/proc/few')
  let running = 0
  let most = 0
  const out = await mapFew([5, 1, 4, 2, 3], 2, async (n) => {
    running++
    most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, n))
    running--
    return n * 10
  })
  expect(out).toEqual([50, 10, 40, 20, 30])
  expect(most).toBe(2)
  expect(await mapFew([], 2, async (n: number) => n)).toEqual([])
  await expect(mapFew([1, 2], 2, async (n) => (n === 2 ? Promise.reject(new Error('no')) : n))).rejects.toThrow('no')
})

test("a run the worker never answers fails on the main side past its own limit, and the stuck worker is replaced", async () => {
  vi.useFakeTimers()
  try {
    const { run, workers } = setup()
    const a = run('git', ['fetch'], { ...opts, timeoutMs: 1000 })
    workers[0].ready()
    await vi.advanceTimersByTimeAsync(1000 + ANSWER_GRACE_MS)
    const r = await a
    expect(r.code).toBeNull()
    expect(r.stderr).toBe(STOPPED_WHILE_RUNNING)
    expect(workers[0].terminated).toBe(true)
    // A late answer from the stuck worker changes nothing, and the next program gets a new worker.
    workers[0].answer(workers[0].sent[0].id, 'late')
    const b = run('git', ['status'], opts)
    expect(workers).toHaveLength(2)
    workers[1].ready()
    workers[1].answer(workers[1].sent[0].id, 'fresh')
    expect((await b).stdout).toBe('fresh')
  } finally {
    vi.useRealTimers()
  }
})

test("a worker that never says it's ready is given up on, and what was waiting runs here", async () => {
  vi.useFakeTimers()
  try {
    const { run, workers, fallback } = setup()
    const a = run('git', ['status'], opts)
    await vi.advanceTimersByTimeAsync(READY_MS)
    expect((await a).stdout).toBe('here:git')
    expect(workers[0].terminated).toBe(true)
    expect(run.gaveUp).toBe(true)
    expect(fallback).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
