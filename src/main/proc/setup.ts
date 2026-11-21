import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { runHere, useProgramRunner } from '../../core/git/run'
import { offThreadRunner, type OffThreadRunner, type WorkerLike } from './offThread'

/** The worker's script. Node can't start a worker from inside app.asar, so it's unpacked (asarUnpack in package.json). */
export function procWorkerScript(mainDir: string): string {
  return join(mainDir, 'procWorker.js').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/**
 * From here on, git and the other programs the main process runs start from a worker thread. Call once, early.
 * PATCHBAY_PROGRAMS_ON_MAIN=1 keeps them on the main thread, as before: for comparing, or if the worker misbehaves.
 */
export function startProgramsOffThread(mainDir: string, log?: (line: string) => void): OffThreadRunner | null {
  if (process.env.PATCHBAY_PROGRAMS_ON_MAIN === '1') {
    log?.('Programs start from the main process (PATCHBAY_PROGRAMS_ON_MAIN).')
    return null
  }
  const script = procWorkerScript(mainDir)
  const runner = offThreadRunner({ start: () => new Worker(script) as unknown as WorkerLike, fallback: runHere, log })
  useProgramRunner(runner)
  return runner
}
