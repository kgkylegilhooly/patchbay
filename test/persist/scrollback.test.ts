import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createScrollbackStore } from '../../src/core/persist/scrollbackStore'

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patchbay scroll-'))
  dir = join(root, 'appdata')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('write then read returns the data, stored at scrollback/<id>.log', async () => {
  const store = createScrollbackStore(dir)

  await store.write('node-1', 'hello\r\n\x1b[31mred\x1b[0m')

  expect(store.read('node-1')).toBe('hello\r\n\x1b[31mred\x1b[0m')
  expect(readFileSync(join(dir, 'scrollback', 'node-1.log'), 'utf8')).toBe('hello\r\n\x1b[31mred\x1b[0m')
})

test('read of an unknown id returns null', () => {
  expect(createScrollbackStore(dir).read('nobody')).toBeNull()
})

test('a later write replaces the earlier one', async () => {
  const store = createScrollbackStore(dir)

  await store.write('n', 'one')
  await store.write('n', 'two')

  expect(store.read('n')).toBe('two')
})

test('scrollback past the cap keeps the tail', async () => {
  const store = createScrollbackStore(dir, 10)

  await store.write('n', '0123456789ABCDE')

  expect(store.read('n')).toBe('56789ABCDE')
  expect(statSync(join(dir, 'scrollback', 'n.log')).size).toBe(10)
})

test('the default cap is 1 MiB', async () => {
  const store = createScrollbackStore(dir)
  const cap = 1048576

  await store.write('n', `${'x'.repeat(10)}${'y'.repeat(cap)}`)

  const kept = store.read('n')!
  expect(kept).toHaveLength(cap)
  expect(kept[0]).toBe('y')
})

test('the cap never cuts a multi-byte character in half', async () => {
  const store = createScrollbackStore(dir, 4)

  // Each é is 2 bytes and € is 3, so a cut at 4 bytes lands inside the €.
  await store.write('n', 'éé€é')

  expect(store.read('n')).toBe('é')
  await store.write('n', 'a€é')
  expect(store.read('n')).toBe('é')
})

test.each(['../../evil', '..\\..\\evil', '..', '.', 'a/b', 'C:\\evil', 'a:stream', 'x\u0000y'])(
  'a node id with path characters cannot escape the scrollback dir: %j',
  async (id) => {
    const store = createScrollbackStore(dir)

    await store.write(id, 'data')

    expect(store.read(id)).toBe('data')
    expect(readdirSync(root)).toEqual(['appdata'])
    expect(readdirSync(dir)).toEqual(['scrollback'])
    const files = readdirSync(join(dir, 'scrollback'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.log$/)
    await store.remove(id)
    expect(readdirSync(join(dir, 'scrollback'))).toEqual([])
  }
)

test('ids that differ only in path characters do not share a file', async () => {
  const store = createScrollbackStore(dir)

  await store.write('a/b', 'slash')
  await store.write('a_b', 'underscore')
  await store.write('a%2Fb', 'literal')

  expect(store.read('a/b')).toBe('slash')
  expect(store.read('a_b')).toBe('underscore')
  expect(store.read('a%2Fb')).toBe('literal')
})

test('remove deletes the file, and removing a missing id is fine', async () => {
  const store = createScrollbackStore(dir)
  await store.write('n', 'data')

  await store.remove('n')
  await store.remove('n')
  await store.remove('never existed')

  expect(store.read('n')).toBeNull()
  expect(existsSync(join(dir, 'scrollback', 'n.log'))).toBe(false)
})

test('writes and a remove issued together apply in order', async () => {
  const store = createScrollbackStore(dir)

  await Promise.all([store.write('a', '1'), store.write('a', '2'), store.write('b', '1'), store.remove('b')])

  expect(store.read('a')).toBe('2')
  expect(store.read('b')).toBeNull()
})

test('no temp file is left behind', async () => {
  const store = createScrollbackStore(dir)

  await store.write('n', 'data')

  expect(readdirSync(join(dir, 'scrollback'))).toEqual(['n.log'])
})
