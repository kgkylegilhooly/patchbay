import { parentPort } from 'node:worker_threads'
import { runHere } from '../../core/git/run'
import type { FromWorker, ToWorker } from './offThread'

// Starts programs for the main process, off its thread. See offThread.ts. Must never import electron.
const port = parentPort
if (port) {
  port.on('message', (m: ToWorker) => {
    void runHere(m.file, m.args, m.o).then((result) => port.postMessage({ id: m.id, result } satisfies FromWorker))
  })
  port.postMessage({ ready: true } satisfies FromWorker)
}
