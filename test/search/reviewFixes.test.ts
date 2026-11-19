import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { searchSources } from '../../src/core/search/sources'
import type { IndexStats, SearchResult, SourceWindow, SyncInput } from '../../src/core/search/types'
import { createSearchEngine } from '../../src/main/search/engine'
import { workerScript } from '../../src/main/search/ipc'
import { createSearchService } from '../../src/main/search/service'
import type { CanvasStore } from '../../src/shared/contract'
import type { CanvasDoc, ClaudeNode } from '../../src/shared/model'
import { claudeSays, claudeUser, codexSays, codexUser, lines } from './fixtures'

const T = Date.UTC(2026, 10, 18, 9, 0)
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-search-fix-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function doc(nodes: ClaudeNode[], closed: CanvasDoc['closed'] = [], projects = ['p1', 'p2']): CanvasDoc {
  const names: Record<string, string> = { p1: 'Patchbay', p2: 'Website' }
  return {
    version: 3,
    projects: projects.map((id) => ({ id, name: names[id], folder: dir, viewport: { x: 0, y: 0, zoom: 1 } })),
    activeProjectId: 'p1',
    nodes,
    edges: [],
    closed,
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}
const agent = (id: string, path: string, projectId = 'p1', over: Partial<ClaudeNode> = {}): ClaudeNode => ({
  id, kind: 'claude', title: `Agent ${id}`, x: 0, y: 0, width: 620, height: 420, parentId: null, projectId, cwd: dir, sessionId: `s-${id}`, transcriptPath: path, after: [], ...over
})
const input = (d: CanvasDoc): SyncInput => searchSources(d, [], T)

describe('opening a result reads the index, not the transcript (H1, H2, L1)', () => {
  it("shows a closed Codex conversation's messages, around the one that matched", async () => {
    const path = join(dir, 'rollout.jsonl')
    const many = Array.from({ length: 60 }, (_, i) => codexSays(`progress note ${i}`, T + i))
    writeFileSync(path, lines(codexUser('Port the exporter', T - 1), ...many.slice(0, 40), codexSays('The exporter streams PNG frames now.', T + 100), ...many.slice(40)))
    const d = doc([], [{ id: 'closed-c1-1', title: 'Exporter', cwd: dir, sessionId: 's', transcriptPath: path, closedAt: T + 999, projectId: 'p1', agent: 'codex' }])
    const engine = createSearchEngine({ indexFile: null })
    const result = (await engine.handle({ type: 'search', input: input(d), query: { text: 'png frames' } })) as SearchResult
    const hit = result.hits[0]
    expect(hit.entry).toBe(41)
    const w = (await engine.handle({ type: 'source', key: hit.key, around: hit.entry, before: 2, after: 2 })) as SourceWindow
    expect(w).toMatchObject({ title: 'Exporter', start: 39, focus: 41, total: 62 })
    expect(w.entries.map((e) => e.text)).toEqual(['progress note 38', 'progress note 39', 'The exporter streams PNG frames now.', 'progress note 40', 'progress note 41'])
  })

  it('keeps a window inside the source, and answers nothing for a source no longer indexed', async () => {
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, lines(claudeUser('one', T), claudeSays('two', T + 1)))
    const engine = createSearchEngine({ indexFile: null })
    await engine.handle({ type: 'sync', input: input(doc([agent('a1', path)])) })
    const key = input(doc([agent('a1', path)])).sources[0].key
    expect(await engine.handle({ type: 'source', key, around: 99, before: 500, after: 500 })).toMatchObject({ start: 0, focus: 1, total: 2 })
    expect(await engine.handle({ type: 'source', key: 'conv:nothing', around: 0, before: 1, after: 1 })).toBeNull()
  })
})

describe('searching never waits for a sync (M3)', () => {
  it('answers at once from the index while a sync runs, and says it is still syncing', async () => {
    const path = join(dir, 'big.jsonl')
    writeFileSync(path, lines(claudeUser('needle in the haystack', T), ...Array.from({ length: 3000 }, (_, i) => claudeSays(`filler ${i} ${'x'.repeat(200)}`, T + i))))
    const engine = createSearchEngine({ indexFile: null })
    const order: string[] = []
    const syncing = engine.handle({ type: 'sync', input: input(doc([agent('a1', path)])) }).then(() => order.push('sync'))
    const searching = engine.handle({ type: 'search', input: input(doc([agent('a1', path)])), query: { text: 'needle' } }).then((r) => {
      order.push('search')
      return r as SearchResult
    })
    const result = await searching
    await syncing
    expect(order).toEqual(['search', 'sync'])
    expect(result.stats.syncing).toBe(true)
  })

  it('skips the sync before a search right after one, and syncs again once that is stale', async () => {
    let clock = T
    const path = join(dir, 'grow.jsonl')
    writeFileSync(path, lines(claudeUser('first words', T)))
    const engine = createSearchEngine({ indexFile: null, now: () => clock })
    const d = doc([agent('a1', path)])
    await engine.handle({ type: 'sync', input: input(d) })
    appendFileSync(path, lines(claudeSays('added afterwards', T + 1)))
    expect(((await engine.handle({ type: 'search', input: input(d), query: { text: 'afterwards' } })) as SearchResult).hits).toHaveLength(0)
    clock += 11_000
    expect(((await engine.handle({ type: 'search', input: input(d), query: { text: 'afterwards' } })) as SearchResult).hits).toHaveLength(1)
  })
})

describe('saving the index (M2)', () => {
  it('waits minutes to save growth, but saves soon after a source is dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const file = join(dir, 'search', 'index.json')
    const a = join(dir, 'a.jsonl')
    const b = join(dir, 'b.jsonl')
    writeFileSync(a, lines(claudeUser('alpha', T)))
    writeFileSync(b, lines(claudeUser('beta', T)))
    const engine = createSearchEngine({ indexFile: file })
    await engine.handle({ type: 'sync', input: input(doc([agent('a1', a), agent('b1', b)])) })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(existsSync(file)).toBe(false)
    rmSync(b)
    await engine.handle({ type: 'sync', input: input(doc([agent('a1', a), agent('b1', b)])) })
    await vi.advanceTimersByTimeAsync(16_000)
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))
  })
})

describe('rebuilding (L3)', () => {
  it("keeps a deleted project's name", async () => {
    const path = join(dir, 'w.jsonl')
    writeFileSync(path, lines(claudeUser('landing copy', T)))
    const closed = [{ id: 'closed-w-1', title: 'Site', cwd: dir, sessionId: 's', transcriptPath: path, closedAt: T, projectId: 'p2' }]
    const engine = createSearchEngine({ indexFile: null })
    await engine.handle({ type: 'sync', input: input(doc([], closed)) })
    const gone = doc([], closed, ['p1'])
    expect(((await engine.handle({ type: 'rebuild', input: input(gone) })) as IndexStats).conversations).toBe(1)
    const r = (await engine.handle({ type: 'search', input: input(gone), query: { text: 'landing' } })) as SearchResult
    expect(r.hits[0]).toMatchObject({ projectName: 'Website', projectGone: true })
  })
})

describe('handoffs from an agent waiting on the person (L2)', () => {
  it('are marked possibly stale', async () => {
    const path = join(dir, 'n.jsonl')
    writeFileSync(path, lines(claudeUser('go', T), claudeSays('May I run the migration?', T + 1)))
    let current = doc([agent('a1', path)])
    const store: CanvasStore = { get: () => current, dispatch: (op) => void (current = reduce(current, op)), subscribe: () => () => {} }
    const engine = createSearchEngine({ indexFile: null })
    const service = createSearchService({ store, messages: () => [], status: () => 'needs-you', gitChanges: async () => ({ unavailable: 'none' }), startNode: async () => {}, backend: (r) => engine.handle(r) })
    const r = await service.prepareHandoff({ type: 'node', nodeId: 'a1' })
    if (!r.ok) throw new Error(r.reason)
    expect(r.draft.sections.find((s) => s.id === 'sources')!.evidence).toBe('stale')
  })
})

describe('the worker in an installed build (M1)', () => {
  it('is loaded from app.asar.unpacked', () => {
    expect(workerScript('C:\\Users\\me\\AppData\\Local\\Programs\\Patchbay\\resources\\app.asar\\out\\main')).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Patchbay\\resources\\app.asar.unpacked\\out\\main\\searchWorker.js')
    expect(workerScript(join('C:', 'code', 'patchbay', 'out', 'main'))).toBe(join('C:', 'code', 'patchbay', 'out', 'main', 'searchWorker.js'))
  })
})
