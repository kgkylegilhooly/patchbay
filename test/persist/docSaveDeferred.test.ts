import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { docJson } from '../../src/core/persist/docJson'
import { createDocStore } from '../../src/core/persist/docStore'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

/**
 * Counts whole-file reads of the save, which a known-good primary no longer needs. A rename onto the primary can be
 * made to fail once as a locked file does, running something in its place.
 */
const reads = vi.hoisted(() => ({ files: [] as string[], lockPrimaryOnce: null as null | (() => void), inFlightPrimaryOnce: null as null | (() => void) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      reads.files.push(String(args[0]))
      return actual.readFile(...args)
    }) as typeof actual.readFile,
    rename: (async (from: string, to: string) => {
      const locked = reads.lockPrimaryOnce
      if (locked && String(to).endsWith('canvas.json')) {
        reads.lockPrimaryOnce = null
        locked()
        throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      }
      // Already handed to the thread pool: whatever runs now can't stop it landing.
      const inFlight = reads.inFlightPrimaryOnce
      if (inFlight && String(to).endsWith('canvas.json')) {
        reads.inFlightPrimaryOnce = null
        inFlight()
      }
      return actual.rename(from, to)
    }) as typeof actual.rename
  }
})

let dir: string
const primary = () => join(dir, 'canvas.json')
const backup = () => join(dir, 'canvas.json.bak')

function doc(title: string, extra: Partial<CanvasDoc> = {}): CanvasDoc {
  return {
    version: 3,
    projects: [{ id: 'p', name: 'P', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p',
    nodes: [{ kind: 'terminal', id: 'n1', title, x: 0, y: 0, width: 400, height: 300, parentId: null, projectId: 'p', cwd: 'C:/a' }],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...extra
  }
}

/** A doc whose node counts each time it's turned into text. */
function counted(title: string): { doc: CanvasDoc; times: () => number } {
  let n = 0
  const d = doc(title)
  const node = d.nodes[0] as CanvasNode & { toJSON?: () => unknown }
  const { ...plain } = node
  node.toJSON = () => (n++, plain)
  return { doc: d, times: () => n }
}

const titleOnDisk = (file: string) => JSON.parse(readFileSync(file, 'utf8')).nodes[0].title

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay deferred-'))
  reads.files.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('a debounced save turns the doc into text only once, when it is written, however many changes came', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const store = createDocStore(dir)
  const docs = Array.from({ length: 30 }, (_, i) => counted(`drag ${i}`))
  for (const d of docs) store.saveDebounced(d.doc)
  expect(docs.map((d) => d.times()).reduce((a, b) => a + b)).toBe(0)
  vi.advanceTimersByTime(500)
  await store.flush()
  expect(docs.slice(0, -1).every((d) => d.times() === 0)).toBe(true)
  expect(docs[29].times()).toBe(1)
  expect(titleOnDisk(primary())).toBe('drag 29')
})

test('flush writes what is pending at once, without waiting for the timer', async () => {
  const store = createDocStore(dir)
  store.saveDebounced(doc('pending'))
  await store.flush()
  expect(titleOnDisk(primary())).toBe('pending')
})

test('flushSync writes the pending doc on the spot, and the old primary becomes the backup', async () => {
  const store = createDocStore(dir)
  await store.save(doc('first'))
  store.saveDebounced(doc('second'))
  store.flushSync()
  expect(titleOnDisk(primary())).toBe('second')
  expect(titleOnDisk(backup())).toBe('first')
  expect(existsSync(`${primary()}.now.tmp`)).toBe(false)
  // Nothing left for the timer or a later flush.
  await store.flush()
  expect(titleOnDisk(primary())).toBe('second')
})

// Windows ending the session must not lose the last changes to a file made read-only from outside, as a save doesn't.
test('flushSync still writes the pending doc when the backup was made read-only from outside', async () => {
  const store = createDocStore(dir)
  await store.save(doc('first'))
  await store.save(doc('second'))
  chmodSync(backup(), 0o444)
  try {
    store.saveDebounced(doc('at session end'))
    store.flushSync()
    expect(titleOnDisk(primary())).toBe('at session end')
    expect(titleOnDisk(backup())).toBe('second')
  } finally {
    chmodSync(backup(), 0o644)
  }
})

test('a read-only copy left by a failed flushSync does not block the next one', async () => {
  const store = createDocStore(dir)
  await store.save(doc('first'))
  chmodSync(primary(), 0o444)
  store.saveDebounced(doc('while read-only'))
  try {
    store.flushSync()
  } catch {
    // Windows can't replace a read-only file: this one may fail.
  }
  chmodSync(primary(), 0o644)
  store.saveDebounced(doc('writable again'))
  store.flushSync()
  expect(titleOnDisk(primary())).toBe('writable again')
  expect(titleOnDisk(backup())).toBe('first')
})

test('the text written is exactly JSON.stringify, and a big unchanged node is not turned into text again', () => {
  const board = { kind: 'whiteboard', id: 'w', title: 'b', x: 0, y: 0, width: 9, height: 9, parentId: null, projectId: 'p', shapes: Array.from({ length: 500 }, () => ({ type: 'pen', color: '#111111', size: 2, points: [1, 2, 3, 4, 5, 6] })) }
  let stringified = 0
  const watched = { ...board, toJSON: () => (stringified++, board) } as unknown as CanvasNode
  const a = doc('a', { nodes: [watched, doc('x').nodes[0]] })
  expect(docJson(a)).toBe(JSON.stringify(a))
  stringified = 0
  // A new doc after a viewport move: the same node object, so its text is reused.
  const b = { ...a, viewport: { x: 5, y: 6, zoom: 1 } }
  expect(docJson(b)).toBe(JSON.stringify({ ...b, nodes: [board, b.nodes[1]] }))
  expect(stringified).toBe(0)
  // Undefined fields are left out, as JSON.stringify leaves them.
  const c = { ...doc('c'), extra: undefined } as unknown as CanvasDoc
  expect(docJson(c)).toBe(JSON.stringify(c))
})

test('a primary this store wrote is copied to the backup without being read again', async () => {
  const store = createDocStore(dir)
  await store.save(doc('one'))
  await store.save(doc('two'))
  await store.save(doc('three'))
  expect(reads.files.filter((f) => f === primary())).toEqual([])
  expect(titleOnDisk(backup())).toBe('two')
})

test('a primary changed by something else is checked before it becomes the backup, and a bad one is set aside', async () => {
  const store = createDocStore(dir)
  await store.save(doc('good'))
  await store.save(doc('newer'))
  writeFileSync(primary(), '{ not json')
  // Same size and time can't be told apart, so the test makes sure the time moves.
  const later = statSync(primary()).mtimeMs / 1000 + 5
  utimesSync(primary(), later, later)
  await store.save(doc('after'))
  expect(reads.files).toContain(primary())
  expect(titleOnDisk(backup())).toBe('good')
  expect(titleOnDisk(primary())).toBe('after')
})

test('a save loaded from disk is trusted the same way, and old saves still load', async () => {
  await createDocStore(dir).save(doc('saved'))
  const store = createDocStore(dir)
  expect(store.load().doc.nodes[0].title).toBe('saved')
  reads.files.length = 0
  await store.save(doc('next'))
  expect(reads.files.filter((f) => f === primary())).toEqual([])
  expect(titleOnDisk(backup())).toBe('saved')
})

test('a save already under way with an older doc does not put it back over what flushSync wrote', async () => {
  const store = createDocStore(dir)
  await store.save(doc('first'))
  const older = store.save(doc('older'))
  store.saveDebounced(doc('newest'))
  // Windows ends the session while the older save is still writing.
  store.flushSync()
  await older
  await store.flush()
  expect(titleOnDisk(primary())).toBe('newest')
})

test('a save whose rename is retried after a lock never puts its older doc over what flushSync wrote meanwhile', async () => {
  const store = createDocStore(dir)
  await store.save(doc('first'))
  // The older save's rename meets a lock; Windows ends the session while it waits to try again.
  reads.lockPrimaryOnce = () => {
    store.saveDebounced(doc('newest'))
    store.flushSync()
  }
  await store.save(doc('older'))
  await store.flush()
  expect(titleOnDisk(primary())).toBe('newest')
})

test('the canvas is never changed in place, which the save cache relies on', async () => {
  const { createAppStore } = await import('../../src/main/appStore')
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o)
      for (const v of Object.values(o)) deepFreeze(v)
    }
    return o
  }
  const sticky = { kind: 'sticky', id: 's', title: 'S', x: 0, y: 0, width: 100, height: 100, parentId: null, projectId: 'p', text: 'hi' } as CanvasNode
  const loaded = deepFreeze(doc('frozen', { nodes: [...doc('frozen').nodes, sticky] }))
  const docs = { load: () => ({ doc: loaded, recoveredFrom: 'primary' as const }), save: async () => {}, saveDebounced: (d: CanvasDoc) => void deepFreeze(d), flush: async () => {}, flushSync: () => {}, seal: () => {} }
  const store = createAppStore(docs)
  // Strict mode: any write into a frozen doc throws here.
  store.dispatch({ op: 'setViewport', viewport: { x: 1, y: 2, zoom: 1 } })
  store.dispatch({ op: 'patchNode', id: 's', patch: { text: 'changed' } })
  store.dispatch({ op: 'moveNodes', moves: [{ id: 'n1', x: 50, y: 60 }] })
  store.dispatch({ op: 'removeNodes', ids: ['s'], at: 1 })
  expect(store.get().nodes.map((n) => n.id)).toEqual(['n1'])
  expect(loaded.nodes).toHaveLength(2)
})

test('a rename already under way when flushSync runs, landing after it, is put right with the newer doc', async () => {
  const store = createDocStore(dir)
  await store.save(doc('first'))
  reads.inFlightPrimaryOnce = () => {
    store.saveDebounced(doc('newest'))
    store.flushSync()
  }
  await store.save(doc('older'))
  await store.flush()
  expect(titleOnDisk(primary())).toBe('newest')
  // The repair is a whole save, so the next one rotates as usual.
  await store.save(doc('after'))
  expect(titleOnDisk(primary())).toBe('after')
  expect(titleOnDisk(backup())).toBe('newest')
})
