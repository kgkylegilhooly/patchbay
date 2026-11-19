import { parentPort, workerData } from 'node:worker_threads'
import { createSearchEngine, type EngineRequest } from './engine'

/**
 * The search worker: a thread of the main process, built as out/main/searchWorker.js. It must never import electron.
 * Each message is { id, request }, answered with { id, ok, value } or { id, ok: false, error }.
 */
const engine = createSearchEngine({ indexFile: (workerData as { indexFile: string | null } | undefined)?.indexFile ?? null })

parentPort?.on('message', (message: { id: number; request: EngineRequest }) => {
  engine.handle(message.request).then(
    (value) => parentPort?.postMessage({ id: message.id, ok: true, value }),
    (e: unknown) => parentPort?.postMessage({ id: message.id, ok: false, error: e instanceof Error ? e.message : String(e) })
  )
})
