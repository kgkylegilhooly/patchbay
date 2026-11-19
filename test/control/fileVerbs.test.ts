import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { CanvasNode, FileNode } from '../../src/shared/model'
import { claudeNode, fakeHost, fakeRunner, memoryStore } from './fakes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay pin ü '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(extra: CanvasNode[] = []) {
  const store = memoryStore([{ ...claudeNode('me', { cwd: dir }), projectId: 'p1' }, ...extra])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const pinned: Array<[string, string, string]> = []
  const verbs = createVerbs({ store, runner, tracker, host: fakeHost(), gate: createAfterGate({ store, tracker, runner }), onFilePinned: (p, path, by) => void pinned.push([p, path, by]) })
  return { store, verbs, pinned }
}

const refused = async (p: Promise<unknown>, pattern: RegExp) => {
  const e = await p.then(
    () => null,
    (err) => err
  )
  expect(e).toBeInstanceOf(RpcRefusal)
  expect(e.message).toMatch(pattern)
}

test('pin-file puts a linked file icon on the canvas for the person, notes it on the shelf, and list shows its path', async () => {
  const file = join(dir, 'résumé final.pdf')
  writeFileSync(file, 'x')
  const { store, verbs, pinned } = setup()
  const r = (await verbs('me', 'pin-file', { path: file })) as { id: string; path: string }
  const node = store.get().nodes.find((n) => n.id === r.id) as FileNode
  expect(node).toMatchObject({ kind: 'file', title: 'résumé final.pdf', path: file, openedBy: 'me' })
  expect(store.get().edges.filter((e) => e.to === r.id).map((e) => e.kind).sort()).toEqual(['link', 'opened'])
  expect(pinned).toEqual([['p1', file, store.get().nodes[0].title]])
  const listed = (await verbs('me', 'list', {})) as { nodes: Array<{ id: string; kind: string; path?: string }> }
  expect(listed.nodes.find((n) => n.id === r.id)).toMatchObject({ kind: 'file', path: file })
})

test('a file icon linked to an agent is context it can read: the path and whether it is there, not the contents', async () => {
  const file = join(dir, 'plan.md')
  writeFileSync(file, 'secret contents')
  const { verbs } = setup()
  const { id } = (await verbs('me', 'pin-file', { path: file })) as { id: string }
  const read = async () => ((await verbs('me', 'read', { node: id })) as { text: string }).text
  expect(await read()).toBe(`A file on the canvas: ${file}\nIt's there. Read it with your own tools if you need what's in it.`)
  expect(await read()).not.toContain('secret contents')
  unlinkSync(file)
  expect(await read()).toMatch(/missing: it was moved or deleted/)
})

test('pin-file refuses a network share, a relative path and a file that is not there', async () => {
  const { verbs, store } = setup()
  await refused(verbs('me', 'pin-file', { path: '\\\\attacker\\share\\x.png' }), /Network paths can't be pinned/)
  await refused(verbs('me', 'pin-file', { path: 'notes.txt' }), /full path/)
  await refused(verbs('me', 'pin-file', { path: join(dir, 'gone.txt') }), /File not found/)
  await refused(verbs('me', 'pin-file', {}), /--path is required/)
  expect(store.get().nodes.filter((n) => n.kind === 'file')).toEqual([])
})
