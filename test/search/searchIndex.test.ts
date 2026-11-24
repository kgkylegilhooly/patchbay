import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSearchIndex, INDEX_VERSION, queryTerms, snippetOf } from '../../src/core/search/searchIndex'
import { conversationKey, searchSources } from '../../src/core/search/sources'
import type { SyncInput } from '../../src/core/search/types'
import type { CanvasDoc, ClaudeNode, StickyNode } from '../../src/shared/model'
import { claudeSays, claudeUser, codexSays, codexUser, lines } from './fixtures'

const DAY = 24 * 3600_000
const T = Date.UTC(2026, 10, 10, 12, 0)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-search-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function baseDoc(): CanvasDoc {
  return {
    version: 3,
    projects: [
      { id: 'p1', name: 'Patchbay', folder: dir, viewport: { x: 0, y: 0, zoom: 1 } },
      { id: 'p2', name: 'Website', folder: dir, viewport: { x: 0, y: 0, zoom: 1 } }
    ],
    activeProjectId: 'p1',
    nodes: [],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

const agent = (id: string, path: string | null, projectId: string, extra: Partial<ClaudeNode> = {}): ClaudeNode => ({
  id, kind: 'claude', title: `Agent ${id}`, x: 0, y: 0, width: 100, height: 100, parentId: null, projectId, cwd: dir, sessionId: 's', transcriptPath: path, after: [], ...extra
})

describe('search index', () => {
  it('finds retained text in a closed conversation and names its project', async () => {
    const path = join(dir, 'closed.jsonl')
    writeFileSync(path, lines(claudeUser('Why does the parser drop unicode?', T), claudeSays('Because the tokenizer splits surrogate pairs. We decided to read code points.', T + 1000)))
    const doc = baseDoc()
    doc.closed = [{ id: 'closed-n1-1', title: 'Parser review', cwd: dir, sessionId: 's', transcriptPath: path, closedAt: T + DAY, projectId: 'p2' }]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    const { hits } = index.search({ text: 'surrogate pairs' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'conversation', title: 'Parser review', projectId: 'p2', projectName: 'Website', ref: { type: 'closed', closedId: 'closed-n1-1' }, role: 'assistant', at: T + 1000 })
    expect(hits[0].snippet).toContain('surrogate pairs')
    expect(hits[0].marks.map(([s, e]) => hits[0].snippet.slice(s, e))).toEqual(['surrogate', 'pairs'])
  })

  it('indexes Codex conversations in the current rollout form', async () => {
    const path = join(dir, 'rollout.jsonl')
    writeFileSync(path, lines(codexUser('Port the exporter', T), codexSays('The exporter now writes PNG files.', T + 1)))
    const doc = baseDoc()
    doc.nodes = [agent('c1', path, 'p1', { agent: 'codex', title: 'Exporter' })]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    expect(index.search({ text: 'png' }).hits[0]).toMatchObject({ title: 'Exporter', agent: 'codex', ref: { type: 'node', nodeId: 'c1' } })
  })

  it('tolerates a transcript being written: half a line is read once it is finished, and damaged lines are skipped', async () => {
    const path = join(dir, 'live.jsonl')
    const late = claudeSays('The migration needs a backfill step.', T + 2000)
    writeFileSync(path, lines(claudeUser('Plan the migration', T), '{"type":"assistant","message":{"con') + late.slice(0, 40))
    const doc = baseDoc()
    doc.nodes = [agent('a1', path, 'p1')]
    const input = searchSources(doc, [], T)
    const index = createSearchIndex()
    await index.sync(input)
    expect(index.search({ text: 'migration' }).hits[0].matches).toBe(1)
    expect(index.search({ text: 'backfill' }).hits).toHaveLength(0)

    appendFileSync(path, `${late.slice(40)}\n`)
    await index.sync(input)
    expect(index.search({ text: 'backfill' }).hits).toHaveLength(1)
    expect(index.doc(conversationKey(path))!.entries.map((e) => e.text)).toEqual(['Plan the migration', 'The migration needs a backfill step.'])

    // Nothing new: nothing changes, and nothing is read twice.
    expect((await index.sync(input)).changed).toBe(false)
    expect(index.doc(conversationKey(path))!.entries).toHaveLength(2)
  })

  it('reads a replaced transcript again from the start', async () => {
    const path = join(dir, 'r.jsonl')
    writeFileSync(path, lines(claudeUser('alpha one', T), claudeSays('alpha two', T + 1)))
    const doc = baseDoc()
    doc.nodes = [agent('a1', path, 'p1')]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    writeFileSync(path, lines(claudeUser('beta', T)))
    await index.sync(searchSources(doc, [], T))
    expect(index.search({ text: 'alpha' }).hits).toHaveLength(0)
    expect(index.search({ text: 'beta' }).hits).toHaveLength(1)
  })

  it('rebuilding the index never changes a source transcript', async () => {
    const path = join(dir, 'keep.jsonl')
    writeFileSync(path, lines(claudeUser('keep me exactly', T), claudeSays('as I am', T + 1)) + '{"partial')
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs, size: statSync(path).size }
    const doc = baseDoc()
    doc.nodes = [agent('a1', path, 'p1')]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    index.clear()
    await index.sync(searchSources(doc, [], T))
    const restored = createSearchIndex(JSON.parse(JSON.stringify(index.toJSON())))
    restored.clear()
    await restored.sync(searchSources(doc, [], T))
    expect(readFileSync(path).equals(before.bytes)).toBe(true)
    expect(statSync(path).mtimeMs).toBe(before.mtime)
    expect(statSync(path).size).toBe(before.size)
    expect(restored.search({ text: 'exactly' }).hits).toHaveLength(1)
  })

  it('picks up from a saved index, reading only what was added since', async () => {
    const path = join(dir, 's.jsonl')
    writeFileSync(path, lines(claudeUser('saved part', T)))
    const doc = baseDoc()
    doc.nodes = [agent('a1', path, 'p1')]
    const first = createSearchIndex()
    await first.sync(searchSources(doc, [], T))
    const saved = JSON.parse(JSON.stringify(first.toJSON()))
    appendFileSync(path, lines(claudeSays('added later', T + 5)))
    const second = createSearchIndex(saved)
    await second.sync(searchSources(doc, [], T))
    expect(second.doc(conversationKey(path))!.entries.map((e) => e.text)).toEqual(['saved part', 'added later'])
  })

  it('starts empty from a saved index of another version or a damaged one', () => {
    expect(createSearchIndex({ version: INDEX_VERSION + 1, docs: [{ key: 'x', entries: [] }], projects: {} }).stats().conversations).toBe(0)
    expect(createSearchIndex('nonsense').stats().notes).toBe(0)
  })

  it('drops a transcript removed from disk, and counts it as missing', async () => {
    const path = join(dir, 'gone.jsonl')
    writeFileSync(path, lines(claudeUser('soon deleted', T)))
    const doc = baseDoc()
    doc.nodes = [agent('a1', path, 'p1')]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    rmSync(path)
    await index.sync(searchSources(doc, [], T))
    expect(index.search({ text: 'deleted' }).hits).toHaveLength(0)
    expect(index.stats()).toMatchObject({ conversations: 0, missing: 1 })
  })

  it("keeps a deleted project's closed conversations, under its last name", async () => {
    const path = join(dir, 'old.jsonl')
    writeFileSync(path, lines(claudeUser('legacy billing rules', T)))
    const doc = baseDoc()
    doc.nodes = [agent('a1', path, 'p2'), { id: 'n1', kind: 'sticky', title: 'Note', text: 'billing notes', x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'p2' } as StickyNode]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    expect(index.search({ text: 'billing' }).hits).toHaveLength(2)
    // What removeProject leaves: the window in the closed history, the note gone, the project gone.
    const after: CanvasDoc = { ...doc, projects: [doc.projects[0]], nodes: [], closed: [{ id: 'closed-a1-9', title: 'Agent a1', cwd: dir, sessionId: 's', transcriptPath: path, closedAt: T + 9, projectId: 'p2' }] }
    await index.sync(searchSources(after, [], T))
    const { hits } = index.search({ text: 'billing' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'conversation', projectName: 'Website', projectGone: true, ref: { type: 'closed', closedId: 'closed-a1-9' } })
  })

  it('filters by project, date and kind', async () => {
    const p1 = join(dir, 'one.jsonl')
    const p2 = join(dir, 'two.jsonl')
    writeFileSync(p1, lines(claudeUser('deploy checklist old', T - 10 * DAY)))
    writeFileSync(p2, lines(claudeUser('deploy checklist new', T)))
    const doc = baseDoc()
    doc.nodes = [agent('a1', p1, 'p1'), agent('a2', p2, 'p2')]
    const messages = [{ from: 'a1', to: 'a2', text: 'deploy is blocked', at: T - DAY }]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, messages, T))
    expect(index.search({ text: 'deploy' }).hits.map((h) => h.key)).toEqual([conversationKey(p2), `msg:${T - DAY}:a1:a2`, conversationKey(p1)])
    expect(index.search({ text: 'deploy', projectId: 'p1' }).hits.map((h) => h.title)).toEqual(['Agent a1'])
    expect(index.search({ text: 'deploy', from: T - 2 * DAY }).hits).toHaveLength(2)
    expect(index.search({ text: 'deploy', to: T - 5 * DAY }).hits.map((h) => h.title)).toEqual(['Agent a1'])
    expect(index.search({ text: 'deploy', kinds: ['message'] }).hits).toMatchObject([{ title: 'Agent a1 to Agent a2', projectId: 'p2', ref: { type: 'message', from: 'a1', to: 'a2' } }])
  })

  it('needs every word in one message, and treats a quoted phrase as one', async () => {
    const path = join(dir, 'w.jsonl')
    writeFileSync(path, lines(claudeUser('red apples', T), claudeSays('green pears', T + 1)))
    const doc = baseDoc()
    doc.nodes = [agent('a1', path, 'p1')]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    expect(index.search({ text: 'red pears' }).hits).toHaveLength(0)
    expect(index.search({ text: '"green pears"' }).hits).toHaveLength(1)
    expect(index.search({ text: '"pears green"' }).hits).toHaveLength(0)
    expect(index.search({ text: '   ' }).hits).toHaveLength(0)
  })

  it('finds a quoted phrase whose words a line break or extra spaces split', async () => {
    const path = join(dir, 'w.jsonl')
    writeFileSync(path, lines(claudeSays('Next I will fix  login for the admin page.', T)))
    const doc = baseDoc()
    const note: StickyNode = { id: 'n1', kind: 'sticky', title: 'Plan', text: '- Then fix\nlogin flow', x: 0, y: 0, width: 200, height: 100, parentId: null, projectId: 'p1' }
    doc.nodes = [agent('a1', path, 'p1'), note]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T))
    expect(index.search({ text: '"fix login"' }).hits.map((h) => h.kind).sort()).toEqual(['conversation', 'note'])
    expect(index.search({ text: '"fix login"', kinds: ['note'] }).hits[0]).toMatchObject({ snippet: expect.stringContaining('fix login'), marks: [expect.any(Array)] })
  })

  it('takes sources from registered providers, such as task results', async () => {
    const doc = baseDoc()
    const extra: SyncInput['sources'] = [{ kind: 'task-result', key: 'task:1', title: 'Task 1 outcome', projectId: 'p1', ref: { type: 'text' }, at: T, text: 'Accepted after review' }]
    const index = createSearchIndex()
    await index.sync(searchSources(doc, [], T, extra))
    expect(index.search({ text: 'accepted' }).hits).toMatchObject([{ kind: 'task-result', title: 'Task 1 outcome' }])
    expect(index.stats().other).toBe(1)
  })
})

describe('sources', () => {
  it('prefers an open window over the closed entry it was reopened from, and names closed senders', () => {
    const doc = baseDoc()
    doc.nodes = [agent('live', 'C:/t/x.jsonl', 'p1')]
    doc.closed = [
      { id: 'closed-live-1', title: 'Old title', cwd: dir, sessionId: 's', transcriptPath: 'c:\\t\\X.jsonl', closedAt: T, projectId: 'p1' },
      { id: 'closed-gone-2', title: 'Gone agent', cwd: dir, sessionId: 's', transcriptPath: null, closedAt: T, projectId: 'p2' }
    ]
    const { sources } = searchSources(doc, [{ from: 'gone', to: 'nobody', text: 'hi', at: T }], T)
    expect(sources.filter((s) => s.kind === 'conversation')).toMatchObject([{ ref: { type: 'node', nodeId: 'live' } }])
    expect(sources.find((s) => s.kind === 'message')).toMatchObject({ title: 'Gone agent to a closed window', projectId: 'p2' })
  })
})

describe('query helpers', () => {
  it('splits words and phrases', () => {
    expect(queryTerms('Foo "bar  baz" foo')).toEqual(['foo', 'bar baz'])
  })
  it('marks every term in the snippet', () => {
    const { snippet, marks } = snippetOf('one two\n\nthree two', ['two'])
    expect(snippet).toBe('one two three two')
    expect(marks).toEqual([[4, 7], [14, 17]])
  })
})
