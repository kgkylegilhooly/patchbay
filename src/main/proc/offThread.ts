import type { ProgramRunner, RunOptions, RunResult } from '../../core/git/run'

/**
 * Starts programs from a worker thread, so the main process never waits on Windows creating a process. Each start
 * holds up the thread that makes it: about 4 ms on a quiet PC, tens of milliseconds on a busy or short-of-memory one,
 * and an agent's turn starts half a dozen git commands to snapshot its files. With eight agents that held the main
 * process, and so every window, input and message in the app, for over half a second at a time.
 * See docs/plans/responsiveness.md.
 */

/** What the worker says: once that it's ready, then each result. */
export type FromWorker = { ready: true } | { id: number; result: RunResult }
export interface ToWorker {
  id: number
  file: string
  args: string[]
  o: RunOptions
}

/** The part of node's Worker this needs, so tests can stand one in. */
export interface WorkerLike {
  postMessage(message: ToWorker): void
  on(event: 'message', cb: (m: FromWorker) => void): unknown
  on(event: 'error', cb: (e: Error) => void): unknown
  on(event: 'exit', cb: (code: number) => void): unknown
  unref?(): void
  terminate(): Promise<number> | void
}

/** A worker that stops this many times while running programs is given up on, and programs start here instead. */
export const CRASHES_BEFORE_GIVING_UP = 3

export const STOPPED_WHILE_RUNNING = "Patchbay's program runner stopped while this was running."

export interface OffThreadRunner extends ProgramRunner {
  /** True once programs start on this thread again, because the worker couldn't start or kept stopping. */
  readonly gaveUp: boolean
  close(): void
}

export function offThreadRunner(d: { start: () => WorkerLike; fallback: ProgramRunner; log?: (line: string) => void }): OffThreadRunner {
  let worker: WorkerLike | null = null
  let ready = false
  let gaveUp = false
  let crashes = 0
  let next = 1
  /** Sent to the worker, waiting for its answer. */
  const running = new Map<number, (r: RunResult) => void>()
  /** Asked for before the worker was ready. Nothing of these has started, so they can still run anywhere. */
  let queued: { msg: ToWorker; done: (r: RunResult) => void }[] = []

  const giveUp = (why: string): void => {
    if (gaveUp) return
    gaveUp = true
    d.log?.(`Programs start from the main process again: ${why}`)
  }

  const runQueuedHere = (): void => {
    const waiting = queued
    queued = []
    for (const { msg, done } of waiting) void d.fallback(msg.file, msg.args, msg.o).then(done)
  }

  const lost = (w: WorkerLike, why: string): void => {
    if (worker !== w) return
    worker = null
    const wasReady = ready
    ready = false
    // Already started: they may have done their work, so they're never run again, only said to have failed.
    for (const done of running.values()) done({ code: null, stdout: '', stderr: STOPPED_WHILE_RUNNING, truncated: false, timedOut: false, missing: false })
    running.clear()
    if (!wasReady) giveUp(`the worker couldn't start (${why}).`)
    else if (++crashes >= CRASHES_BEFORE_GIVING_UP) giveUp(`the worker stopped ${crashes} times (${why}).`)
    else d.log?.(`The program runner stopped (${why}). A new one starts with the next program.`)
    if (gaveUp) runQueuedHere()
    else if (queued.length) start()
  }

  const start = (): void => {
    let w: WorkerLike
    try {
      w = d.start()
    } catch (e) {
      giveUp(`the worker couldn't start (${(e as Error).message}).`)
      runQueuedHere()
      return
    }
    worker = w
    w.unref?.()
    w.on('message', (m) => {
      if (worker !== w) return
      if ('ready' in m) {
        ready = true
        const waiting = queued
        queued = []
        for (const { msg, done } of waiting) send(w, msg, done)
        return
      }
      const done = running.get(m.id)
      running.delete(m.id)
      done?.(m.result)
    })
    w.on('error', (e) => lost(w, e.message))
    w.on('exit', (code) => lost(w, `exit code ${code}`))
  }

  const send = (w: WorkerLike, msg: ToWorker, done: (r: RunResult) => void): void => {
    running.set(msg.id, done)
    try {
      w.postMessage(msg)
    } catch (e) {
      running.delete(msg.id)
      void d.fallback(msg.file, msg.args, msg.o).then(done)
      d.log?.(`A program couldn't be handed to the runner (${(e as Error).message}), so it started here.`)
    }
  }

  const run = ((file: string, args: string[], o: RunOptions): Promise<RunResult> => {
    if (gaveUp) return d.fallback(file, args, o)
    return new Promise<RunResult>((done) => {
      const msg: ToWorker = { id: next++, file, args, o }
      if (worker && ready) return send(worker, msg, done)
      queued.push({ msg, done })
      if (!worker) start()
    })
  }) as OffThreadRunner

  Object.defineProperty(run, 'gaveUp', { get: () => gaveUp })
  run.close = () => {
    const w = worker
    worker = null
    gaveUp = true
    running.clear()
    runQueuedHere()
    void w?.terminate()
  }
  return run
}
