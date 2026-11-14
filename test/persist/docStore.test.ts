import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDocStore, migrate } from '../../src/core/persist/docStore'
import type { CanvasDoc } from '../../src/shared/model'

/** Real file system, with a log of what happened and rename failures on demand. */
const fsSpy = vi.hoisted(() => ({
  events: [] as string[],
  renameFailures: [] as string[]
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const realSync = handle.sync.bind(handle)
      handle.sync = async () => {
        fsSpy.events.push(`fsync ${basename(String(args[0]))}`)
        return realSync()
      }
      return handle
    },
    rename: async (from: string, to: string) => {
      fsSpy.events.push(`rename ${basename(from)} ${basename(to)}`)
      const code = fsSpy.renameFailures.shift()
      if (code) throw Object.assign(new Error(code), { code })
      return actual.rename(from, to)
    }
  }
})

let dir: string
const primary = () => join(dir, 'canvas.json')
const backup = () => join(dir, 'canvas.json.bak')

function docTitled(title: string): CanvasDoc {
  return {
    version: 3,
    projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p',
    nodes: [
      { kind: 'terminal', id: 'n1', title, x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p', cwd: 'C:/a b' }
    ],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

const titleOnDisk = (file: string) => JSON.parse(readFileSync(file, 'utf8')).nodes[0].title
const corruptFiles = () => readdirSync(dir).filter((f) => /^canvas\.corrupt-.*\.json$/.test(f))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay doc-'))
  fsSpy.events.length = 0
  fsSpy.renameFailures.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('save writes temp, fsyncs, renames; the previous primary becomes .bak', async () => {
  const store = createDocStore(dir)
  await store.save(docTitled('first'))
  fsSpy.events.length = 0

  await store.save(docTitled('second'))

  expect(titleOnDisk(primary())).toBe('second')
  expect(titleOnDisk(backup())).toBe('first')
  const fsyncAt = fsSpy.events.indexOf('fsync canvas.json.tmp')
  const renameAt = fsSpy.events.indexOf('rename canvas.json.tmp canvas.json')
  expect(fsyncAt).toBeGreaterThanOrEqual(0)
  expect(renameAt).toBeGreaterThan(fsyncAt)
  expect(existsSync(`${primary()}.tmp`)).toBe(false)
})

test('the primary is never absent while a save rotates the backup', async () => {
  const store = createDocStore(dir)
  await store.save(docTitled('first'))
  fsSpy.events.length = 0

  await store.save(docTitled('second'))

  expect(fsSpy.events).not.toContain('rename canvas.json canvas.json.bak')
})

test('load reads back a saved doc from the primary', async () => {
  const doc = docTitled('saved')
  await createDocStore(dir).save(doc)

  const result = createDocStore(dir).load()

  expect(result.recoveredFrom).toBe('primary')
  expect(result.doc).toEqual(doc)
  expect(result.quarantined).toBeUndefined()
})

test('an empty folder loads a new empty doc', () => {
  const result = createDocStore(dir).load()

  expect(result.recoveredFrom).toBe('new')
  expect(result.doc.nodes).toEqual([])
  expect(result.quarantined).toBeUndefined()
})

test('a folder that does not exist yet loads new and is created on save', async () => {
  const store = createDocStore(join(dir, 'not', 'yet'))

  expect(store.load().recoveredFrom).toBe('new')
  await store.save(docTitled('x'))

  expect(titleOnDisk(join(dir, 'not', 'yet', 'canvas.json'))).toBe('x')
})

test('truncated primary loads .bak and moves the bad file to canvas.corrupt-<ts>.json', async () => {
  const store = createDocStore(dir)
  await store.save(docTitled('good'))
  await store.save(docTitled('newer'))
  const full = readFileSync(primary(), 'utf8')
  const half = full.slice(0, full.length / 2)
  writeFileSync(primary(), half)

  const result = createDocStore(dir).load()

  expect(result.recoveredFrom).toBe('backup')
  expect(result.doc.nodes[0].title).toBe('good')
  expect(corruptFiles()).toHaveLength(1)
  expect(result.quarantined).toBe(join(dir, corruptFiles()[0]))
  expect(readFileSync(result.quarantined!, 'utf8')).toBe(half)
  expect(existsSync(primary())).toBe(false)
})

test('after recovering from .bak, the next save does not destroy the backup', async () => {
  const first = createDocStore(dir)
  await first.save(docTitled('good'))
  await first.save(docTitled('newer'))
  writeFileSync(primary(), '{"version":1,')

  const store = createDocStore(dir)
  store.load()
  await store.save(docTitled('after recovery'))

  expect(titleOnDisk(primary())).toBe('after recovery')
  expect(titleOnDisk(backup())).toBe('good')
})

test('saving over a corrupt primary without a load keeps the backup and the bad file', async () => {
  const first = createDocStore(dir)
  await first.save(docTitled('good'))
  await first.save(docTitled('newer'))
  writeFileSync(primary(), 'garbage')

  await createDocStore(dir).save(docTitled('later'))

  expect(titleOnDisk(backup())).toBe('good')
  expect(titleOnDisk(primary())).toBe('later')
  expect(corruptFiles().map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(['garbage'])
})

test('a missing primary with a good .bak loads the backup', async () => {
  const store = createDocStore(dir)
  await store.save(docTitled('good'))
  await store.save(docTitled('newer'))
  rmSync(primary())

  const result = createDocStore(dir).load()

  expect(result.recoveredFrom).toBe('backup')
  expect(result.doc.nodes[0].title).toBe('good')
  expect(result.quarantined).toBeUndefined()
})

test('both files bad: new doc, bad files kept, recoveredFrom new', () => {
  writeFileSync(primary(), 'bad primary')
  writeFileSync(backup(), 'bad backup')

  const result = createDocStore(dir).load()

  expect(result.recoveredFrom).toBe('new')
  expect(result.doc.nodes).toEqual([])
  expect(result.quarantined).toBeDefined()
  const kept = corruptFiles().map((f) => readFileSync(join(dir, f), 'utf8'))
  expect(kept.sort()).toEqual(['bad backup', 'bad primary'])
})

test('a missing primary with a bad .bak keeps the bad file and reports it', () => {
  writeFileSync(backup(), 'bad backup')

  const result = createDocStore(dir).load()

  expect(result.recoveredFrom).toBe('new')
  expect(readFileSync(result.quarantined!, 'utf8')).toBe('bad backup')
})

test('a future version number is quarantined, not parsed as valid', async () => {
  const store = createDocStore(dir)
  await store.save(docTitled('good'))
  await store.save(docTitled('newer'))
  const future = JSON.stringify({ ...docTitled('from the future'), version: 99 })
  writeFileSync(primary(), future)

  const result = createDocStore(dir).load()

  expect(result.recoveredFrom).toBe('backup')
  expect(result.doc.nodes[0].title).toBe('good')
  expect(readFileSync(result.quarantined!, 'utf8')).toBe(future)
})

test('a primary that cannot be read is an error, never an empty canvas', () => {
  // A folder in the primary's place gives a read error that is not "file missing".
  mkdirSync(primary())

  expect(() => createDocStore(dir).load()).toThrow()
  expect(existsSync(primary())).toBe(true)
})

test.each<[string, unknown]>([
  ['null', null],
  ['an array', []],
  ['no version', { nodes: [], edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } }],
  ['a string version', { ...docTitled('a'), version: '1' }],
  ['version 0', { ...docTitled('a'), version: 0 }],
  ['a future version', { ...docTitled('a'), version: 99 }],
  ['missing nodes', { ...docTitled('a'), nodes: undefined }],
  ['missing edges', { ...docTitled('a'), edges: undefined }],
  ['missing closed', { ...docTitled('a'), closed: undefined }],
  ['missing viewport', { ...docTitled('a'), viewport: undefined }],
  ['a non-numeric viewport', { ...docTitled('a'), viewport: { x: 0, y: 0, zoom: 'big' } }],
  ['a node with no id', { ...docTitled('a'), nodes: [{ kind: 'sticky', text: '' }] }],
  ['a node of an unknown kind', { ...docTitled('a'), nodes: [{ ...docTitled('a').nodes[0], kind: 'toaster' }] }],
  ['a terminal with no cwd', { ...docTitled('a'), nodes: [{ ...docTitled('a').nodes[0], cwd: undefined }] }],
  ['a bad edge', { ...docTitled('a'), edges: [{ id: 'e', from: 'a', to: 'b', kind: 'nope' }] }],
  ['a bad closed entry', { ...docTitled('a'), closed: [{ id: 'c' }] }],
  ['a whiteboard with no shapes list', { ...docTitled('a'), nodes: [{ ...docTitled('a').nodes[0], kind: 'whiteboard', shapes: undefined }] }],
  ['a whiteboard shape whose color is not a color', { ...docTitled('a'), nodes: [{ ...docTitled('a').nodes[0], kind: 'whiteboard', shapes: [{ type: 'line', color: 'red;}', size: 2, x1: 0, y1: 0, x2: 1, y2: 1 }] }] }]
])('migrate rejects %s', (_name, raw) => {
  expect(() => migrate(raw)).toThrow()
})

test('migrate accepts a current doc with every node kind', () => {
  const base = { title: 't', x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'p' }
  const doc: CanvasDoc = {
    version: 3,
    projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p',
    nodes: [
      { ...base, kind: 'group', id: 'g', worktree: { path: 'p', branch: 'b', repo: 'r' } },
      { ...base, kind: 'group', id: 'g2', worktree: null },
      { ...base, kind: 'terminal', id: 't', cwd: 'c', parentId: 'g' },
      { ...base, kind: 'claude', id: 'c', cwd: 'c', sessionId: null, transcriptPath: null, after: ['t'] },
      { ...base, kind: 'sticky', id: 's', text: '# hi' },
      { ...base, kind: 'whiteboard', id: 'w', shapes: [{ type: 'pen', color: '#1f1f22', size: 4, points: [0, 0, 5, 5] }, { type: 'text', color: '#2f6fd6', size: 2, x: 1, y: 1, text: 'hi' }] }
    ],
    edges: [{ id: 'e', from: 'c', to: 't', kind: 'opened' }],
    closed: [{ id: 'x', title: 't', cwd: 'c', sessionId: 's', transcriptPath: null, closedAt: 5 }],
    viewport: { x: 1, y: 2, zoom: 0.5 }
  }

  expect(migrate(doc)).toEqual(doc)
})

test('flush persists a pending debounced save', async () => {
  const store = createDocStore(dir)

  store.saveDebounced(docTitled('pending'))
  expect(existsSync(primary())).toBe(false)
  await store.flush()

  expect(titleOnDisk(primary())).toBe('pending')
})

test('debounced saves wait 500 ms and write only the latest doc', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const store = createDocStore(dir)

  store.saveDebounced(docTitled('one'))
  store.saveDebounced(docTitled('two'))
  vi.advanceTimersByTime(499)
  await vi.waitFor(() => expect(existsSync(primary())).toBe(false))
  vi.advanceTimersByTime(1)
  await store.flush()

  expect(titleOnDisk(primary())).toBe('two')
  expect(existsSync(backup())).toBe(false)
})

test('nonstop changes still reach disk within 500 ms of the first one', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const store = createDocStore(dir)

  for (let i = 0; i < 10; i++) {
    store.saveDebounced(docTitled(`drag ${i}`))
    vi.advanceTimersByTime(100)
  }
  await vi.waitFor(() => expect(existsSync(primary())).toBe(true))
  await store.flush()

  expect(titleOnDisk(primary())).toBe('drag 9')
})

test('a direct save cancels an older pending debounced save', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const store = createDocStore(dir)

  store.saveDebounced(docTitled('stale'))
  await store.save(docTitled('fresh'))
  vi.advanceTimersByTime(1000)
  await store.flush()

  expect(titleOnDisk(primary())).toBe('fresh')
})

test('concurrent saves leave the last doc on disk', async () => {
  const store = createDocStore(dir)

  await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(docTitled(`doc ${i}`))))

  expect(titleOnDisk(primary())).toBe('doc 19')
  expect(titleOnDisk(backup())).toBe('doc 18')
})

test('a failed debounced save reports the error, and flush retries it', async () => {
  const errors: unknown[] = []
  const store = createDocStore(dir, { onSaveError: (e) => errors.push(e) })
  // A folder in the temp file's place makes the write fail.
  mkdirSync(`${primary()}.tmp`)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  store.saveDebounced(docTitled('unsaved'))
  vi.advanceTimersByTime(500)
  await vi.waitFor(() => expect(errors).toHaveLength(1))
  await expect(store.flush()).rejects.toThrow()

  rmSync(`${primary()}.tmp`, { recursive: true })
  await store.flush()
  expect(titleOnDisk(primary())).toBe('unsaved')
})

test('a failed save does not block the saves after it', async () => {
  const store = createDocStore(dir)
  mkdirSync(`${primary()}.tmp`)

  await expect(store.save(docTitled('fails'))).rejects.toThrow()
  rmSync(`${primary()}.tmp`, { recursive: true })
  await store.save(docTitled('works'))

  expect(titleOnDisk(primary())).toBe('works')
})

test.each(['EPERM', 'EBUSY'])('save retries a rename that fails with %s', async (code) => {
  fsSpy.renameFailures.push(code, code)

  await createDocStore(dir).save(docTitled('retried'))

  expect(titleOnDisk(primary())).toBe('retried')
})

test('save gives up after 5 rename attempts over about 500 ms and keeps the old primary', async () => {
  const store = createDocStore(dir)
  await store.save(docTitled('old'))
  fsSpy.events.length = 0
  fsSpy.renameFailures.push('EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY')
  const started = Date.now()

  await expect(store.save(docTitled('new'))).rejects.toThrow('EBUSY')

  expect(fsSpy.events.filter((e) => e.startsWith('rename'))).toHaveLength(5)
  expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  expect(titleOnDisk(primary())).toBe('old')
})

test('a rename failure other than EPERM or EBUSY is not retried', async () => {
  fsSpy.renameFailures.push('ENOSPC')

  await expect(createDocStore(dir).save(docTitled('x'))).rejects.toThrow('ENOSPC')

  expect(fsSpy.events.filter((e) => e.startsWith('rename'))).toHaveLength(1)
})
