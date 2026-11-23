/**
 * The main/host audit's microbenchmarks (.claude/audits/main-host-perf.md, copies/mainhost/test/audit-*.test.ts), run
 * against any copy of src: PB_PROBE_SRC is its folder (default: this branch's), PB_PROBE_OUT the JSONL file results go
 * to, PB_PROBE_LABEL what each row is called. Not part of `npx vitest run`: see vitest.probe.config.ts.
 *
 *   npx vitest run --config test/perf/vitest.probe.config.ts
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
const SRC = resolve(process.env.PB_PROBE_SRC ?? join(__dirname, '..', '..', 'src'))
const OUT = process.env.PB_PROBE_OUT ?? join(tmpdir(), 'pb-probe.jsonl')
const LABEL = process.env.PB_PROBE_LABEL ?? 'after'
const load = (rel: string): Promise<any> => import(/* @vite-ignore */ `file:///${join(SRC, rel).replace(/\\/g, '/')}.ts`)
const record = (name: string, data: object): void => appendFileSync(OUT, JSON.stringify({ label: LABEL, name, ...data }) + '\n')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The longest the event loop was held while `work` ran. */
async function longestBlock(work: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  await work()
  h.disable()
  return h.max / 1e6
}

test('1: canvas serialization per viewport operation', async () => {
  const { createDocStore } = await load('core/persist/docStore')
  const { createAppStore } = await load('main/appStore')
  for (const strokes of [0, 100, 1000]) {
    const dir = mkdtempSync(join(tmpdir(), 'pb-probe-doc-'))
    const points = Array.from({ length: 8000 }, (_, i) => i % 1000)
    const doc: any = { version: 3, projects: [1, 2, 3].map((i) => ({ id: 'p' + i, name: 'Project ' + i, folder: dir, viewport: { x: 0, y: 0, zoom: 1 } })), activeProjectId: 'p1', viewport: { x: 0, y: 0, zoom: 1 }, edges: [], closed: [], nodes: Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, kind: 'terminal', title: 't' + i, cwd: dir, x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p1' })) }
    if (strokes) doc.nodes.push({ id: 'wb', kind: 'whiteboard', title: 'board', x: 0, y: 0, width: 500, height: 500, parentId: null, projectId: 'p3', shapes: Array.from({ length: strokes }, () => ({ type: 'pen', color: '#111111', size: 2, points })) })
    writeFileSync(join(dir, 'canvas.json'), JSON.stringify(doc))
    const bytes = statSync(join(dir, 'canvas.json')).size
    const ds = createDocStore(dir)
    let t = performance.now()
    const app = createAppStore(ds)
    const loadMs = performance.now() - t
    const times: number[] = []
    for (let i = 0; i < 60; i++) {
      t = performance.now()
      app.dispatch({ op: 'setViewport', viewport: { x: i, y: i, zoom: 1 } })
      times.push(performance.now() - t)
    }
    // The debounced write itself, then a second burst and save, as continuous dragging would do.
    t = performance.now()
    await ds.flush()
    const flushMs = performance.now() - t
    for (let i = 0; i < 60; i++) app.dispatch({ op: 'setViewport', viewport: { x: -i, y: i, zoom: 1 } })
    t = performance.now()
    await ds.flush()
    const secondFlushMs = performance.now() - t
    times.sort((a, b) => a - b)
    record('DOC', { strokes, bytes, loadMs, p50Ms: times[30], p95Ms: times[57], totalMs: times.reduce((a, b) => a + b, 0), flushMs, secondFlushMs })
  }
}, 120_000)

test('4: a locked file, as the settings IPC reads it', async () => {
  const atomic = await load('core/persist/atomicFile')
  const locked = (): (() => string) => {
    let calls = 0
    return () => {
      if (++calls < 5) throw Object.assign(new Error('fake file lock'), { code: 'EBUSY' })
      return 'settings'
    }
  }
  const started = performance.now()
  let timerAt = 0
  const fired = new Promise<void>((r) => setTimeout(() => ((timerAt = performance.now() - started), r()), 0))
  // Before: the IPC handlers read through the sync retry. After: through the async one.
  const ipcAsync = LABEL !== 'before'
  let blockedMs: number
  let doneMs: number
  if (ipcAsync) {
    const action = locked()
    const p = atomic.withLockRetry(async () => action())
    blockedMs = performance.now() - started
    await p
    doneMs = performance.now() - started
  } else {
    atomic.withLockRetrySync(locked())
    blockedMs = performance.now() - started
    doneMs = blockedMs
  }
  await fired
  record('LOCK', { blockedMs, timerAt, doneMs })
})

test('6: HTTP hooks with an app that stops answering', async () => {
  const { startHostHooks } = await load('main/sessions/hostHooks')
  const dir = mkdtempSync(join(tmpdir(), 'pb-probe-hooks-'))
  const hooks = await startHostHooks({ journalDir: dir, replyLimitMs: 5 })
  hooks.allow('fake', 'secret')
  let forwarded = 0
  const healthy = { forward(hid: number) { forwarded++; hooks.answer(hid, {}) }, cancel() {} }
  hooks.connect(healthy)
  const post = (): Promise<string> => fetch(`http://127.0.0.1:${hooks.port}/hook/PostToolUse`, { method: 'POST', headers: { 'x-patchbay-node': 'fake', authorization: 'Bearer secret' }, body: JSON.stringify({ tool_name: 'Read' }) }).then((r) => r.text())
  try {
    let t = performance.now()
    for (let i = 0; i < 1000; i += 10) await Promise.all(Array.from({ length: 10 }, post))
    const normalMs = performance.now() - t
    hooks.disconnect(healthy)
    let backlog = 0
    const hung = { forward() { backlog++ }, cancel() {} }
    hooks.connect(hung)
    t = performance.now()
    for (let i = 0; i < 6000; i += 100) await Promise.all(Array.from({ length: 100 }, post))
    const ms = performance.now() - t
    const pendingAtEnd = hooks.unanswered?.() ?? (globalThis as any).__auditHookPending?.() ?? null
    hooks.disconnect(hung)
    record('HTTP', { normalEvents: forwarded, normalMs, unansweredEvents: backlog, unansweredMs: ms, pendingAtEnd, heapMB: process.memoryUsage().heapUsed / 1048576 })
  } finally {
    await hooks.close()
  }
}, 120_000)

test('7 and 9: whiteboard pictures at start-up and over IPC', async () => {
  const images = await load('main/boardImages')
  const dir = mkdtempSync(join(tmpdir(), 'pb-probe-images-'))
  const bytes = Buffer.alloc(10 * 1024 * 1024, 42)
  let t = performance.now()
  const file = images.saveBoardImage(dir, bytes, 'image/png')
  const saveSyncMs = performance.now() - t
  for (let i = 0; i < 2000; i++) writeFileSync(join(dir, i.toString(16).padStart(64, '0') + '.png'), 'x')
  if (!images.readBoardImageAsync) {
    t = performance.now()
    for (let i = 0; i < 10; i++) images.readBoardImage(dir, file)
    const tenReadsMs = performance.now() - t
    t = performance.now()
    images.pruneBoardImages(dir, new Set())
    const pruneMs = performance.now() - t
    // All of it on the caller's thread, and the prune before the window.
    record('IMAGES', { saveBlockMs: saveSyncMs, tenReadsBlockMs: tenReadsMs, tenReadsDoneMs: tenReadsMs, preWindowPruneMs: pruneMs, pruneDoneMs: pruneMs, pruneBlockMs: pruneMs })
    return
  }
  images.clearBoardImageCache()
  const fresh = Buffer.alloc(10 * 1024 * 1024, 43)
  let saveDone = 0
  const saveBlockMs = await longestBlock(async () => {
    t = performance.now()
    await images.saveBoardImageAsync(dir, fresh, 'image/png')
    saveDone = performance.now() - t
  })
  let tenReadsDoneMs = 0
  const tenReadsBlockMs = await longestBlock(async () => {
    t = performance.now()
    for (let i = 0; i < 10; i++) await images.readBoardImageAsync(dir, file)
    tenReadsDoneMs = performance.now() - t
  })
  // Before the window: only the set of pictures in use is taken; the prune itself runs later.
  t = performance.now()
  const used = new Set<string>()
  const preWindowPruneMs = performance.now() - t
  let pruneDoneMs = 0
  const pruneBlockMs = await longestBlock(async () => {
    t = performance.now()
    await images.pruneBoardImagesAsync(dir, used)
    pruneDoneMs = performance.now() - t
  })
  record('IMAGES', { saveBlockMs, saveDoneMs: saveDone, tenReadsBlockMs, tenReadsDoneMs, preWindowPruneMs, pruneDoneMs, pruneBlockMs })
}, 120_000)

test('10: fragmented host frames', async () => {
  const { createFrameReader, encodeFrame } = await load('main/sessions/hostProtocol')
  const frame = encodeFrame({ t: 'o', id: 'fake', d: 'a'.repeat(1024 * 1024) })
  const results: object[] = []
  for (const chunk of [frame.length, 65536, 4096]) {
    let parsed = 0
    const r = createFrameReader({ limit: frame.length, onFrame() { parsed++ }, onError(e: string) { throw Error(e) } })
    const t = performance.now()
    for (let n = 0; n < 20; n++) for (let at = 0; at < frame.length; at += chunk) r.push(frame.subarray(at, at + chunk))
    results.push({ chunk, parsed, ms: performance.now() - t })
  }
  record('FRAMES', { results })
})

test('5: a new build whose host must be copied before it can start', async () => {
  const { createBackgroundHost } = await load('main/sessions/backgroundHost')
  const { startHostServer } = await load('main/sessions/hostServer')
  const { hostRuntime } = await load('main/sessions/hostSpawn')
  const { HOST_PROTOCOL } = await load('main/sessions/hostProtocol')
  // Stands in for the install folder: a program and app files the size of the real ones.
  const install = join(tmpdir(), 'pb-probe-install')
  mkdirSync(join(install, 'resources'), { recursive: true })
  try {
    statSync(join(install, 'Patchbay.exe'))
  } catch {
    writeFileSync(join(install, 'Patchbay.exe'), Buffer.alloc(250 * 1024 * 1024, 1))
    writeFileSync(join(install, 'resources', 'app.asar'), Buffer.alloc(25 * 1024 * 1024, 2))
  }
  const baseDir = mkdtempSync(join(tmpdir(), 'pb-probe-runtime-'))
  const pipe = `\\\\.\\pipe\\patchbay-probe-${randomUUID()}`
  const sessions = { start() {}, write() {}, resize() {}, async kill() {}, pid: () => null, isRunning: () => false, snapshot: () => ({ data: '', seq: 0 }), onOutput() {}, onExit() {}, list: () => [], forget() {}, pause() {}, resume() {} }
  let server: any = null
  const app = createBackgroundHost({
    pipe,
    secret: 's',
    spawnHost: async () => {
      await hostRuntime({ installDir: install, baseDir, version: 'probe', mainDir: join(install, 'resources') })
      server = await startHostServer({ pipe, secret: 's', protocol: HOST_PROTOCOL, version: 'probe', startedAt: 1, sessions, onStopRequested() {} })
    },
    createLocal: () => sessions,
    startTimeoutMs: 30_000
  })
  const t = performance.now()
  // What boot waits for before it makes the window.
  const atBoot = await app.connect({ quick: true })
  const windowWaitMs = performance.now() - t
  const connected = await app.connect()
  const hostReadyMs = performance.now() - t
  record('RUNTIME', { windowWaitMs, hostReadyMs, modeAtWindow: atBoot.mode, modeAfter: connected.mode })
  await app.detach()
  await server?.close()
  await sleep(100)
}, 120_000)
