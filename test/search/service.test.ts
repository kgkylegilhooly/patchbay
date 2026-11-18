import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { handoffPrompt } from '../../src/core/search/handoffText'
import type { CanvasStore } from '../../src/shared/contract'
import type { AgentStatus, CanvasDoc, ClaudeNode } from '../../src/shared/model'
import { createSearchEngine } from '../../src/main/search/engine'
import { createSearchService, registerHandoffEvidence, registerSearchSource, workerBackend } from '../../src/main/search/service'
import { claudeSays, claudeTool, claudeUser, lines } from './fixtures'

const T = Date.UTC(2026, 10, 18, 9, 0)
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-search-svc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function store(doc: CanvasDoc): CanvasStore {
  const subs = new Set<(d: CanvasDoc) => void>()
  return {
    get: () => doc,
    dispatch(op) {
      doc = reduce(doc, op)
      for (const cb of subs) cb(doc)
    },
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    }
  }
}

const agent = (id: string, path: string, projectId: string, over: Partial<ClaudeNode> = {}): ClaudeNode => ({
  id, kind: 'claude', title: `Agent ${id}`, x: 0, y: 0, width: 620, height: 420, parentId: null, projectId, cwd: dir, sessionId: `s-${id}`, transcriptPath: path, after: [], ...over
})

function setup(statuses: Record<string, AgentStatus> = {}) {
  const path = join(dir, 'a1.jsonl')
  writeFileSync(path, lines(claudeUser('Make the export async', T), claudeTool('e1', 'Edit', { file_path: join(dir, 'export.ts') }, T + 1), claudeSays('We decided to stream the PNG instead of buffering it.', T + 2)))
  const s = store({
    version: 3,
    projects: [
      { id: 'p1', name: 'Patchbay', folder: dir, viewport: { x: 0, y: 0, zoom: 1 } },
      { id: 'p2', name: 'Website', folder: dir, viewport: { x: 0, y: 0, zoom: 1 } }
    ],
    activeProjectId: 'p1',
    nodes: [agent('a1', path, 'p2')],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  })
  const started: string[] = []
  const indexFile = join(dir, 'data', 'search', 'index.json')
  const engine = createSearchEngine({ indexFile, now: () => T + 3600_000 })
  const service = createSearchService({
    store: s,
    messages: () => [{ from: 'a1', to: 'a1', text: 'note to self about streaming', at: T + 5 }],
    status: (id) => statuses[id],
    gitChanges: async (folder) => ({ root: folder, changed: ['export.ts'] }),
    startNode: async (id) => void started.push(id),
    backend: (r) => engine.handle(r),
    now: () => T
  })
  return { s, service, started, path, indexFile, engine }
}

describe('search service', () => {
  it('finds a conversation after its window is closed, naming its project, and opens the closed entry', async () => {
    const { s, service } = setup()
    expect((await service.search({ text: 'stream png' })) as never).toMatchObject({ ok: true, result: { hits: [{ ref: { type: 'node', nodeId: 'a1' } }] } })
    s.dispatch({ op: 'removeNodes', ids: ['a1'], at: T + 10 })
    const r = await service.search({ text: 'stream png' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.result.hits).toHaveLength(1)
    expect(r.result.hits[0]).toMatchObject({ kind: 'conversation', projectId: 'p2', projectName: 'Website', ref: { type: 'closed', closedId: s.get().closed[0].id } })
    // Messages come from the retained log.
    expect((await service.search({ text: 'streaming', kinds: ['message'] })) as never).toMatchObject({ ok: true, result: { hits: [{ kind: 'message' }] } })
  })

  it('saves the index and rebuilds it without touching the transcript', async () => {
    const { service, path, indexFile, engine } = setup()
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs }
    await service.search({ text: 'export' })
    await engine.handle({ type: 'flush' })
    expect(existsSync(indexFile)).toBe(true)
    const r = await service.rebuild()
    expect(r).toMatchObject({ ok: true, stats: { conversations: 1, messages: 1 } })
    expect(readFileSync(path).equals(before.bytes)).toBe(true)
    expect(statSync(path).mtimeMs).toBe(before.mtime)
    // A new engine starts from what was saved.
    const again = createSearchEngine({ indexFile })
    expect(await again.handle({ type: 'stats' })).toMatchObject({ conversations: 1 })
  })

  it('prepares a handoff from a window or a closed conversation, extracted without AI', async () => {
    const { s, service } = setup()
    const r = await service.prepareHandoff({ type: 'node', nodeId: 'a1' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.draft).toMatchObject({ sourceTitle: 'Agent a1', agent: 'claude', cwd: dir, projectId: 'p2' })
    const ids = r.draft.sections.map((x) => x.id)
    expect(ids).toEqual(['objective', 'decisions', 'changed', 'verification', 'remaining', 'sources'])
    expect(r.draft.sections.find((x) => x.id === 'decisions')!.text).toContain('stream the PNG')
    expect(r.draft.sections.find((x) => x.id === 'changed')!.text).toContain('[Stale: missing on disk now]')
    expect(r.draft.sections.find((x) => x.id === 'verification')!.evidence).toBe('missing')
    expect(r.draft.sections.find((x) => x.id === 'sources')!.text).toContain('project Website')

    s.dispatch({ op: 'removeNodes', ids: ['a1'], at: T + 10 })
    const closed = await service.prepareHandoff({ type: 'closed', closedId: s.get().closed[0].id })
    expect(closed.ok).toBe(true)
    expect(await service.prepareHandoff({ type: 'node', nodeId: 'a1' })).toMatchObject({ ok: false })
  })

  it('marks a handoff from a working agent as possibly stale', async () => {
    const { service } = setup({ a1: 'working' })
    const r = await service.prepareHandoff({ type: 'node', nodeId: 'a1' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.draft.sections.find((x) => x.id === 'sources')!.evidence).toBe('stale')
  })

  it('starts the next agent with the edited handoff, beside the source', async () => {
    const { s, service, started } = setup()
    const r = await service.prepareHandoff({ type: 'node', nodeId: 'a1' })
    if (!r.ok) throw new Error(r.reason)
    const edited = r.draft.sections.map((x) => (x.id === 'objective' ? { ...x, text: 'My edited objective' } : x))
    const text = handoffPrompt(r.draft, edited, 'codex')
    const out = await service.startHandoff({ text, agent: 'codex', cwd: dir, title: 'Continue export', projectId: 'p2', besideNodeId: 'a1' })
    if (!out.ok) throw new Error(out.reason)
    const node = s.get().nodes.find((n) => n.id === out.nodeId) as ClaudeNode
    expect(node).toMatchObject({ kind: 'claude', agent: 'codex', title: 'Continue export', projectId: 'p2', cwd: dir })
    expect(node.prompt).toContain('My edited objective')
    expect(node.x).toBeGreaterThan(620)
    expect(started).toEqual([out.nodeId])
  })

  it('refuses to start an empty or too long handoff, or one in a missing folder', async () => {
    const { service, started } = setup()
    expect(await service.startHandoff({ text: '  ', agent: 'claude', cwd: dir, title: 'x' })).toMatchObject({ ok: false })
    expect(await service.startHandoff({ text: 'x'.repeat(30000), agent: 'claude', cwd: dir, title: 'x' })).toMatchObject({ ok: false, reason: expect.stringContaining('over the') })
    expect(await service.startHandoff({ text: 'go', agent: 'claude', cwd: join(dir, 'nope'), title: 'x' })).toMatchObject({ ok: false, reason: expect.stringContaining("doesn't exist") })
    expect(started).toEqual([])
  })

  it('takes documents and handoff sections from registered providers', async () => {
    const { service } = setup()
    const offSource = registerSearchSource(() => [{ kind: 'task-result', key: 'task:9', title: 'Task 9', projectId: 'p1', ref: { type: 'text' }, at: T, text: 'verified by acceptance run' }])
    const offEvidence = registerHandoffEvidence(() => [{ id: 'task', title: 'Task outcome', text: 'Accepted', evidence: 'found' }])
    try {
      expect((await service.search({ text: 'acceptance run' })) as never).toMatchObject({ ok: true, result: { hits: [{ kind: 'task-result' }] } })
      const r = await service.prepareHandoff({ type: 'node', nodeId: 'a1' })
      if (!r.ok) throw new Error(r.reason)
      expect(r.draft.sections.map((x) => x.id)).toContain('task')
    } finally {
      offSource()
      offEvidence()
    }
  })
})

describe('worker backend', () => {
  it('answers through a worker thread, and starts a new one after it fails', async () => {
    const script = join(dir, 'echo-worker.cjs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      script,
      `const { parentPort } = require('node:worker_threads')
       parentPort.on('message', ({ id, request }) => {
         if (request.type === 'flush') process.exit(3)
         parentPort.postMessage(request.type === 'stats' ? { id, ok: true, value: 'stats' } : { id, ok: false, error: 'no ' + request.type })
       })`
    )
    const logged: string[] = []
    const backend = workerBackend(script, join(dir, 'index.json'), (l) => logged.push(l))
    expect(await backend({ type: 'stats' })).toBe('stats')
    await expect(backend({ type: 'sync', input: { sources: [], projects: {} } })).rejects.toThrow('no sync')
    await expect(backend({ type: 'flush' })).rejects.toThrow('stopped')
    expect(await backend({ type: 'stats' })).toBe('stats')
  })

  it('runs search in this process when the worker script never loads', async () => {
    const logged: string[] = []
    const backend = workerBackend(join(dir, 'no-such-worker.js'), join(dir, 'index.json'), (l) => logged.push(l))
    expect(await backend({ type: 'stats' })).toMatchObject({ conversations: 0, syncedAt: null })
    expect(await backend({ type: 'sync', input: { sources: [], projects: {} } })).toMatchObject({ conversations: 0 })
    expect(logged.some((l) => l.includes('runs in the main process'))).toBe(true)
  })
})
