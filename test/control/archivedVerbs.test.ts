import { expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { createProjectArchiver, sitesOf } from '../../src/main/projects/archive'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import type { BrowserNode, CanvasNode, Project, TriggerNode } from '../../src/shared/model'
import { canonicalSpec } from '../../src/core/trigger/arming'
import { claudeNode, fakeHost, fakeRunner, memoryStore, terminalNode } from './fakes'

const view = { x: 0, y: 0, zoom: 1 }
const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id === 'live' ? 'Live work' : 'Old work',
  folder: '',
  viewport: view,
  ...over
})

/** Two projects: the caller's open one, and one to archive. Ids are global, so a node is named across projects. */
function setup(extra: CanvasNode[] = []) {
  const store = memoryStore([
    claudeNode('me', { projectId: 'live' }),
    claudeNode('peer', { projectId: 'live', openedBy: 'me' }),
    claudeNode('old', { projectId: 'old', openedBy: 'me', sessionId: 'keep-me' }),
    terminalNode('shell', { projectId: 'old' }),
    ...extra
  ])
  store.dispatch({ op: 'addProject', project: project('old') })
  store.dispatch({ op: 'addProject', project: project('live') })
  store.dispatch({ op: 'addEdge', edge: { id: 'l', from: 'me', to: 'old', kind: 'link' } })
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const host = fakeHost()
  const verbs = createVerbs({ store, runner, tracker, host, gate: createAfterGate({ store, tracker, runner }), timing: { enterDelayMs: 0, settleMs: 10 } })
  return { store, runner, host, verbs }
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err
  )
  expect(e).toBeInstanceOf(RpcRefusal)
  return (e as Error).message
}

test('list and whoami are unchanged for an open project', async () => {
  const { store, verbs } = setup()
  store.dispatch({ op: 'archiveProject', id: 'old', at: 1 })
  const listed = (await verbs('me', 'list', {})) as { nodes: Array<{ id: string }> }
  expect(listed.nodes.map((n) => n.id)).toEqual(['me', 'peer'])
  const who = (await verbs('me', 'whoami', {})) as { text: string }
  expect(who.text).toContain('Live work')
})

test("an archived project's nodes can't be reached, by id or by title, and say why", async () => {
  const { store, verbs } = setup()
  store.dispatch({ op: 'archiveProject', id: 'old', at: 1 })
  expect(await refusal(verbs('me', 'read', { node: 'old' }))).toMatch(/Node "old" is in the archived project "Old work", so it can't be reached or started/)
  expect(await refusal(verbs('me', 'send', { node: 'old', text: 'hi' }))).toMatch(/archived project/)
  expect(await refusal(verbs('me', 'wait', { nodes: ['peer', 'old'] }))).toMatch(/archived project/)
})

test('a node in an archived project is refused every verb', async () => {
  const { store, verbs } = setup()
  store.dispatch({ op: 'archiveProject', id: 'old', at: 1 })
  expect(await refusal(verbs('old', 'list', {}))).toMatch(/Your project "Old work" is archived/)
  expect(await refusal(verbs('old', 'whoami', {}))).toMatch(/unarchive it from the projects manager/)
})

test('once unarchived, its nodes can be reached again', async () => {
  const { store, verbs } = setup()
  store.dispatch({ op: 'archiveProject', id: 'old', at: 1 })
  store.dispatch({ op: 'unarchiveProject', id: 'old', open: false })
  await expect(verbs('old', 'list', {})).resolves.toBeTruthy()
})

const page = (id: string, projectId: string, url: string, openedBy: string | null = null): BrowserNode => ({
  id,
  kind: 'browser',
  title: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  parentId: null,
  projectId,
  url,
  openedBy
})

test('archiving stops what runs, disarms triggers, keeps agents resumable, and clears only what was asked', async () => {
  const trigger: TriggerNode = {
    id: 'nightly',
    kind: 'trigger',
    title: 'Nightly',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    parentId: null,
    projectId: 'old',
    schedule: { type: 'interval', everyMs: 60_000 },
    prompt: 'go',
    targetId: 'old',
    armedSpec: null,
    armedAt: null,
    nextAt: null,
    runs: []
  }
  const { store, host, runner } = setup([
    trigger,
    page('docs', 'old', 'https://docs.example.com/a'),
    page('shared', 'old', 'https://github.com/x'),
    page('also', 'live', 'https://github.com/y'),
    page('blank', 'old', 'about:blank')
  ])
  store.dispatch({ op: 'setTriggerState', id: 'nightly', state: { armedSpec: canonicalSpec(trigger), armedAt: 1, nextAt: 2 } })
  host.running.add('old')
  host.running.add('shell')
  host.running.add('me')
  const disarmed: string[] = []
  const forgotten: string[] = []
  const cleared: string[] = []
  const archiver = createProjectArchiver({
    store,
    isRunning: (id) => host.running.has(id),
    stopNode: async (id) => {
      await runner.stopNode(id)
      host.running.delete(id)
    },
    disarmTrigger: (id) => void disarmed.push(id),
    scrollbackBytes: (id) => (id === 'shell' ? 2048 : 0),
    forgetOutput: async (id) => void forgotten.push(id),
    clearSite: async (which, origin) => void cleared.push(`${which} ${origin}`),
    now: () => 99
  })

  const preview = archiver.preview('old')
  expect(preview).toMatchObject({
    ok: true,
    name: 'Old work',
    scrollbackBytes: 2048,
    triggers: [{ id: 'nightly' }],
    kept: { notes: 0, whiteboards: 0, groups: 0, board: false }
  })
  if (!preview.ok) throw new Error('expected a preview')
  expect(preview.sessions.find((s) => s.id === 'old')).toMatchObject({ running: true, resumable: true })
  expect(preview.sites).toEqual([
    { origin: 'https://docs.example.com', store: 'person', sharedWith: [] },
    { origin: 'https://github.com', store: 'person', sharedWith: ['Live work'] }
  ])

  const result = await archiver.archive('old', { clearScrollback: true, clearSites: true })
  expect(result).toEqual({
    ok: true,
    stopped: 2,
    stillRunning: [],
    freedBytes: 2048,
    clearedSites: ['https://docs.example.com'],
    keptSites: ['https://github.com']
  })
  expect(runner.stopped.sort()).toEqual(['old', 'shell'])
  expect(host.running.has('me')).toBe(true)
  expect(disarmed).toEqual(['nightly'])
  expect(forgotten.sort()).toEqual(['old', 'shell'])
  expect(cleared).toEqual(['person https://docs.example.com'])
  const doc = store.get()
  expect(doc.projects.find((p) => p.id === 'old')).toMatchObject({ archivedAt: 99, closedAt: 99 })
  // The agent keeps its session id, so it resumes when started again.
  expect(doc.nodes.find((n) => n.id === 'old')).toMatchObject({ sessionId: 'keep-me' })
  expect(doc.nodes.filter((n) => n.projectId === 'old')).toHaveLength(6)
})

test('without the options, nothing is cleared', async () => {
  const { store, host } = setup([page('docs', 'old', 'https://docs.example.com')])
  const cleared: string[] = []
  const archiver = createProjectArchiver({
    store,
    isRunning: (id) => host.running.has(id),
    stopNode: async () => {},
    disarmTrigger: () => {},
    scrollbackBytes: () => 10,
    forgetOutput: async (id) => void cleared.push(id),
    clearSite: async (_w, origin) => void cleared.push(origin)
  })
  expect(await archiver.archive('old', { clearScrollback: false, clearSites: false })).toMatchObject({ ok: true, freedBytes: 0, clearedSites: [] })
  expect(cleared).toEqual([])
})

test('archiving the last project that is not archived is refused before anything is stopped', async () => {
  const { store, runner } = setup()
  store.dispatch({ op: 'archiveProject', id: 'old', at: 1 })
  const archiver = createProjectArchiver({
    store,
    isRunning: () => true,
    stopNode: (id) => runner.stopNode(id),
    disarmTrigger: () => {},
    scrollbackBytes: () => 0,
    forgetOutput: async () => {},
    clearSite: async () => {}
  })
  expect(await archiver.archive('live', { clearScrollback: false, clearSites: false })).toEqual({
    ok: false,
    reason: expect.stringMatching(/only project that isn't archived/)
  })
  expect(runner.stopped).toEqual([])
})

test("agents' pages are a separate store from the person's", () => {
  const { store } = setup([page('mine', 'old', 'https://a.test'), page('theirs', 'live', 'https://a.test', 'peer')])
  expect(sitesOf(store.get(), 'old')).toEqual([{ origin: 'https://a.test', store: 'person', sharedWith: [] }])
})
