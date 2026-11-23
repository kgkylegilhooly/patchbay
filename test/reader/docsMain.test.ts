import { READER_DEFAULT, readerSize } from '../../src/core/reader/readerSize'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spotNear } from '../../src/main/control/verbs'
import { createCommentStore } from '../../src/main/reader/commentStore'
import { findPlan, isLongMarkdown } from '../../src/main/reader/planFind'
import { checkDocPath, docKey } from '../../src/main/reader/policy'
import { createDocsService, titleFrom, type DocsWatcher } from '../../src/main/reader/service'
import { withDocVerbs } from '../../src/main/reader/verbs'
import type { CanvasNode, ClaudeNode, GroupNode, ReaderNode, TerminalNode } from '../../src/shared/model'
import { memoryStore } from '../control/fakes'

const SYSTEM = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']

describe('checkDocPath', () => {
  it('takes a Markdown or text file on a local drive', () => {
    expect(checkDocPath('C:\\Users\\me\\plan.md', SYSTEM)).toEqual({ ok: true, path: 'C:\\Users\\me\\plan.md' })
    expect(checkDocPath('D:/work/notes/README.markdown', SYSTEM).ok).toBe(true)
    expect(checkDocPath('C:\\Users\\me\\plan.txt', SYSTEM).ok).toBe(true)
  })

  it('refuses other kinds of file', () => {
    expect(checkDocPath('C:\\Users\\me\\run.exe', SYSTEM)).toMatchObject({ ok: false, reason: expect.stringContaining('Markdown and text files') })
    expect(checkDocPath('C:\\Users\\me\\.env', SYSTEM).ok).toBe(false)
  })

  it('refuses network shares and device paths', () => {
    expect(checkDocPath('\\\\server\\share\\plan.md', SYSTEM)).toMatchObject({ ok: false, reason: expect.stringContaining('Network') })
    expect(checkDocPath('\\\\?\\C:\\plan.md', SYSTEM).ok).toBe(false)
    expect(checkDocPath('//server/share/plan.md', SYSTEM).ok).toBe(false)
  })

  it('refuses Windows and program folders, however the path is cased', () => {
    expect(checkDocPath('c:\\windows\\system32\\notes.md', SYSTEM)).toMatchObject({ ok: false, reason: expect.stringContaining('C:\\Windows') })
    expect(checkDocPath('C:\\Program Files\\App\\README.md', SYSTEM).ok).toBe(false)
    expect(checkDocPath('C:\\ProgramData\\x\\a.md', SYSTEM).ok).toBe(false)
    // A folder whose name only starts the same way is fine.
    expect(checkDocPath('C:\\Windows-notes\\a.md', SYSTEM).ok).toBe(true)
  })

  it('refuses relative paths, streams and names Windows would change', () => {
    expect(checkDocPath('plan.md', SYSTEM).ok).toBe(false)
    expect(checkDocPath('C:\\x\\a.txt:hidden.md', SYSTEM).ok).toBe(false)
    expect(checkDocPath('C:\\x\\plan.md.', SYSTEM).ok).toBe(false)
    expect(checkDocPath('', SYSTEM).ok).toBe(false)
  })

  it('keys the same file the same way however it is written', () => {
    expect(docKey('C:\\Work\\Plan.md')).toBe(docKey('c:/work/plan.md'))
  })
})

const line = (o: unknown): string => JSON.stringify(o)
const says = (text: string, extra: object = {}): string => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra })
const tool = (name: string, input: object): string => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } })
const LONG = `# Report\n\n${'A finding worth reading. '.repeat(40)}`

describe('findPlan', () => {
  const home = 'C:\\Users\\me'

  it('takes the plan file ExitPlanMode names, as Claude Code records it', () => {
    const lines = [says(LONG), tool('ExitPlanMode', { plan: '# Plan', planFilePath: 'C:\\Users\\me\\.claude\\plans\\brave-otter.md' })]
    expect(findPlan(lines, home)).toEqual({ kind: 'file', path: 'C:\\Users\\me\\.claude\\plans\\brave-otter.md', what: 'plan file' })
  })

  it('takes the plan text when there is no file', () => {
    expect(findPlan([tool('ExitPlanMode', { plan: '# Plan\n\nDo it.' })], home)).toEqual({ kind: 'text', text: '# Plan\n\nDo it.', what: 'plan' })
  })

  it('takes a plan file written into the plans folder', () => {
    expect(findPlan([tool('Write', { file_path: 'C:\\Users\\me\\.claude\\plans\\p.md', content: 'x' })], home)).toMatchObject({ kind: 'file', path: 'C:\\Users\\me\\.claude\\plans\\p.md' })
    expect(findPlan([tool('Write', { file_path: 'C:\\Users\\me\\elsewhere\\p.md', content: 'x' })], home)).toBeNull()
  })

  it('prefers the newest plan, even over a later long answer', () => {
    const lines = [tool('ExitPlanMode', { plan: 'old' }), tool('ExitPlanMode', { plan: 'new' }), says(LONG)]
    expect(findPlan(lines, home)).toMatchObject({ kind: 'text', text: 'new' })
  })

  it('falls back to the newest long answer, skipping short ones and side chains', () => {
    const lines = [says(`${LONG} first`), says(`${LONG} second`), says('ok'), says(`${LONG} side`, { isSidechain: true }), '{"partial":']
    expect(findPlan(lines, home)).toEqual({ kind: 'text', text: `${LONG} second`, what: 'answer' })
  })

  it('finds nothing in a conversation with neither', () => {
    expect(findPlan([says('short'), line({ type: 'user', message: { role: 'user', content: LONG } })], home)).toBeNull()
  })

  it('counts structured answers as long', () => {
    expect(isLongMarkdown(`## Steps\n${'- step\n'.repeat(12)}`)).toBe(true)
    expect(isLongMarkdown('- a\n- b')).toBe(false)
  })
})

describe('titleFrom', () => {
  it('uses the first top-level heading without its marks', () => {
    expect(titleFrom('intro\n\n# The **new** `store` [plan](x.md)\n\n# Second')).toBe('The new store plan')
    expect(titleFrom('## Only a subheading')).toBeNull()
  })
})

describe('docs service', () => {
  let dir: string
  let dataDir: string
  let watched: Map<string, () => void>
  let centered: string[]
  let opened: string[]
  const agent = (id: string, transcriptPath: string | null, cwd: string): ClaudeNode => ({ id, kind: 'claude', title: 'Planner', x: 0, y: 0, width: 600, height: 400, parentId: null, cwd, sessionId: null, transcriptPath, after: [], projectId: 'p1' })
  const terminal = (cwd: string): TerminalNode => ({ id: 'term', kind: 'terminal', title: 'Shell', x: 0, y: 500, width: 500, height: 300, parentId: null, cwd, projectId: 'p1' })

  const make = (nodes: (ClaudeNode | TerminalNode | ReaderNode)[] = [], view?: { width: number; height: number }) => {
    const store = memoryStore(nodes)
    store.dispatch({ op: 'addProject', project: { id: 'p1', name: 'P', folder: dir, viewport: { x: 0, y: 0, zoom: 1 } } })
    const watcher: DocsWatcher = { watch: (p, cb) => watched.set(docKey(p), cb), unwatch: (p) => watched.delete(docKey(p)) }
    const comments = createCommentStore(join(dataDir, 'reader'))
    let n = 0
    const service = createDocsService({
      store,
      dataDir,
      home: dir,
      comments,
      fs: { realpath, stat, readFile: (p) => readFile(p, 'utf8'), writeFile: (p, t) => writeFile(p, t, 'utf8'), mkdir: async (p) => void (await mkdir(p, { recursive: true })), exists: existsSync },
      watcher,
      changed: () => {},
      center: (id) => centered.push(id),
      view: () => view ?? null,
      near: spotNear,
      link: { exists: existsSync, openExternal: async (u) => void opened.push(u), openPath: async (p) => (opened.push(p), ''), reveal: (p) => void opened.push(`reveal ${p}`) },
      system: SYSTEM,
      newId: () => `id${++n}`
    })
    return { store, service, comments }
  }
  const readers = (store: ReturnType<typeof memoryStore>): ReaderNode[] => store.get().nodes.filter((x): x is ReaderNode => x.kind === 'reader')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-reader-'))
    dataDir = join(dir, 'appdata')
    watched = new Map()
    centered = []
    opened = []
    writeFileSync(join(dir, 'plan.md'), '\uFEFF# Ship the store\n\nEvery user moves.\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('opens a file in a reader titled by its first heading, and watches it', async () => {
    const { store, service } = make()
    const r = await service.open({ path: join(dir, 'plan.md'), at: { x: 10, y: 20 } })
    expect(r).toEqual({ ok: true, nodeId: 'id1' })
    expect(readers(store)).toMatchObject([{ id: 'id1', title: 'Ship the store', path: join(dir, 'plan.md'), x: 10, y: 20, projectId: 'p1' }])
    expect(watched.has(docKey(join(dir, 'plan.md')))).toBe(true)
    const read = await service.read('id1')
    expect(read).toMatchObject({ ok: true, text: '# Ship the store\n\nEvery user moves.\n' })
  })

  it('sizes a reader the person opens to the visible window, and keeps the usual size for one an agent opens', async () => {
    writeFileSync(join(dir, 'notes.md'), '# Notes\n')
    const { store, service } = make([agent('a1', null, dir)], { width: 1500, height: 900 })
    await service.open({ path: join(dir, 'plan.md') })
    expect(readers(store)[0]).toMatchObject(readerSize({ width: 1500, height: 900 }, 1))
    expect(readers(store)[0].width).toBeGreaterThan(READER_DEFAULT.width)
    const byAgent = await service.openFile(join(dir, 'notes.md'), { from: store.get().nodes.find((x) => x.id === 'a1'), openedBy: 'a1' })
    expect(byAgent.ok).toBe(true)
    expect(readers(store).find((x) => x.path === join(dir, 'notes.md'))).toMatchObject(READER_DEFAULT)
  })

  it('brings forward the reader already open on a file instead of opening another', async () => {
    const { store, service } = make()
    await service.open({ path: join(dir, 'plan.md') })
    const again = await service.open({ path: join(dir, 'PLAN.md') })
    expect(again).toEqual({ ok: true, nodeId: 'id1' })
    expect(readers(store)).toHaveLength(1)
    expect(centered).toEqual(['id1', 'id1'])
  })

  it('resolves a path printed in a terminal against its folder', async () => {
    const { store, service } = make([terminal(dir)])
    expect(await service.open({ path: 'plan.md:3', fromNodeId: 'term' })).toMatchObject({ ok: true })
    expect(readers(store)[0]).toMatchObject({ path: join(dir, 'plan.md'), fromNodeId: 'term' })
  })

  it('refuses what a reader may not open, and makes no node', async () => {
    writeFileSync(join(dir, 'tool.exe'), 'MZ')
    writeFileSync(join(dir, 'big.md'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61))
    mkdirSync(join(dir, 'folder.md'))
    const { store, service } = make()
    expect(await service.open({ path: join(dir, 'tool.exe') })).toMatchObject({ ok: false, reason: expect.stringContaining('Markdown') })
    expect(await service.open({ path: join(dir, 'missing.md') })).toMatchObject({ ok: false, reason: expect.stringContaining('gone') })
    expect(await service.open({ path: join(dir, 'big.md') })).toMatchObject({ ok: false, reason: expect.stringContaining('too large') })
    expect(await service.open({ path: join(dir, 'folder.md') })).toMatchObject({ ok: false, reason: expect.stringContaining("isn't a file") })
    expect(await service.open({ path: 'C:\\Windows\\notes.md' })).toMatchObject({ ok: false })
    expect(readers(store)).toEqual([])
  })

  it('reads only files that reader nodes name, and says when one is gone', async () => {
    const { store, service } = make()
    expect(await service.read('nope')).toMatchObject({ ok: false })
    await service.open({ path: join(dir, 'plan.md') })
    rmSync(join(dir, 'plan.md'))
    expect(await service.read('id1')).toMatchObject({ ok: false, missing: true })
    store.dispatch({ op: 'removeNodes', ids: ['id1'], at: 1 })
    expect(watched.size).toBe(0)
  })

  it('opens the plan file from an agent conversation beside it, linked to it', async () => {
    const plans = join(dir, '.claude', 'plans')
    mkdirSync(plans, { recursive: true })
    writeFileSync(join(plans, 'brave-otter.md'), '# Plan\n\nSteps.\n')
    const transcript = join(dir, 't.jsonl')
    writeFileSync(transcript, `${tool('ExitPlanMode', { plan: '# Plan', planFilePath: join(plans, 'brave-otter.md') })}\n`)
    const { store, service } = make([agent('a1', transcript, dir)])
    expect(await service.openPlan('a1')).toEqual({ ok: true, nodeId: 'id1', what: 'plan file' })
    expect(readers(store)[0]).toMatchObject({ path: join(plans, 'brave-otter.md'), fromNodeId: 'a1', x: 640 })
    expect(store.get().edges).toMatchObject([{ from: 'a1', to: 'id1', kind: 'link' }])
  })

  it('keeps a plan that only exists in the transcript as a snapshot in app data', async () => {
    const transcript = join(dir, 't.jsonl')
    writeFileSync(transcript, `${says(LONG)}\n`)
    const { store, service } = make([agent('a1', transcript, dir)])
    expect(await service.openPlan('a1')).toMatchObject({ ok: true, what: 'answer' })
    const node = readers(store)[0]
    expect(node.path.startsWith(join(dataDir, 'reader', 'snapshots'))).toBe(true)
    expect(node.title).toBe('Report')
    expect(await readFile(node.path, 'utf8')).toBe(LONG)
    // The same answer opens the same reader.
    expect(await service.openPlan('a1')).toMatchObject({ ok: true, nodeId: node.id })
  })

  it('says why there is no plan to open', async () => {
    const transcript = join(dir, 't.jsonl')
    writeFileSync(transcript, `${says('hi')}\n`)
    const { service } = make([agent('a1', transcript, dir), agent('a2', null, dir), agent('a3', join(dir, 'gone.jsonl'), dir)])
    expect(await service.openPlan('a1')).toMatchObject({ ok: false, reason: expect.stringContaining('no plan or long answer') })
    expect(await service.openPlan('a2')).toMatchObject({ ok: false, reason: expect.stringContaining("hasn't started") })
    expect(await service.openPlan('a3')).toMatchObject({ ok: false, reason: expect.stringContaining('no longer exists') })
    expect(await service.openPlan('nope')).toMatchObject({ ok: false })
  })

  it('keeps comments per file, across readers and restarts', async () => {
    const { store, service } = make()
    await service.open({ path: join(dir, 'plan.md') })
    const c = { id: 'c1', anchor: null, text: 'Looks good', createdAt: 1, resolved: false }
    expect(await service.saveComments('id1', [c, { bogus: true } as never])).toEqual({ ok: true })
    store.dispatch({ op: 'removeNodes', ids: ['id1'], at: 1 })
    const again = make()
    await again.service.open({ path: join(dir, 'plan.md') })
    expect(again.service.comments('id1')).toEqual({ ok: true, comments: [c] })
  })

  it('opens links: another document beside this one, web links in the browser, anchors nowhere', async () => {
    writeFileSync(join(dir, 'spec.md'), '# Spec\n')
    const { store, service } = make()
    await service.open({ path: join(dir, 'plan.md') })
    expect(await service.openLink('id1', './spec.md#scope')).toEqual({ ok: true })
    expect(readers(store).map((r) => r.path)).toEqual([join(dir, 'plan.md'), join(dir, 'spec.md')])
    expect(await service.openLink('id1', 'https://example.com/x')).toEqual({ ok: true })
    expect(await service.openLink('id1', '#scope')).toEqual({ ok: true })
    expect(await service.openLink('id1', 'javascript:alert(1)')).toMatchObject({ ok: false })
    expect(opened).toEqual(['https://example.com/x'])
  })
})

describe('doc verbs', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-reader-verbs-'))
    writeFileSync(join(dir, 'plan.md'), '# Plan\n\n## Rollout\n\nEvery user at once.\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const setup = (o: { cwd?: string; home?: string; parentId?: string; nodes?: CanvasNode[] } = {}) => {
    const caller: ClaudeNode = { id: 'agent', kind: 'claude', title: 'Planner', x: 0, y: 0, width: 600, height: 400, parentId: o.parentId ?? null, cwd: o.cwd ?? dir, sessionId: null, transcriptPath: null, after: [], projectId: 'p1' }
    const other: ClaudeNode = { ...caller, id: 'other', title: 'Other', parentId: null }
    const store = memoryStore([...(o.nodes ?? []), caller, other])
    const comments = createCommentStore(join(dir, 'appdata'))
    const service = createDocsService({
      store,
      dataDir: join(dir, 'appdata'),
      home: o.home ?? dir,
      comments,
      fs: { realpath, stat, readFile: (p) => readFile(p, 'utf8'), writeFile: (p, t) => writeFile(p, t, 'utf8'), mkdir: async (p) => void (await mkdir(p, { recursive: true })), exists: existsSync },
      watcher: { watch: () => {}, unwatch: () => {} },
      changed: () => {},
      near: spotNear,
      link: { exists: existsSync, openExternal: async () => {}, openPath: async () => '', reveal: () => {} },
      system: SYSTEM
    })
    const base = vi.fn(async () => 'passed through')
    const verbs = withDocVerbs(base, { store, docs: service, comments })
    return { store, verbs, base, comments }
  }

  it('opens a document beside the agent, opened by it and linked to it', async () => {
    const { store, verbs } = setup()
    const r = (await verbs('agent', 'open-doc', { path: join(dir, 'plan.md') })) as { id: string; path: string }
    expect(r.path).toBe(join(dir, 'plan.md'))
    const node = store.get().nodes.find((n) => n.id === r.id)
    expect(node).toMatchObject({ kind: 'reader', openedBy: 'agent', fromNodeId: 'agent', title: 'Plan' })
    expect(store.get().edges.map((e) => [e.from, e.to, e.kind])).toEqual([
      ['agent', r.id, 'opened'],
      ['agent', r.id, 'link']
    ])
  })

  it("limits an agent to its own folder, its worktree, its project's folder and the plans folder", async () => {
    const file = (rel: string): string => {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, '# Doc\n')
      return p
    }
    const own = file('work/notes.md')
    const plan = file('home/.claude/plans/brave-otter.md')
    const project = file('proj/spec.md')
    const tree = file('tree/design.md')
    const secret = file('home/Documents/passwords.txt')
    const appData = file('home/AppData/Roaming/tool/notes.md')
    const group: GroupNode = { id: 'g', kind: 'group', title: 'Tree', x: 0, y: 0, width: 900, height: 900, parentId: null, worktree: { path: join(dir, 'tree'), branch: 'b', repo: dir }, projectId: 'p1' }
    const { store, verbs } = setup({ cwd: join(dir, 'work'), home: join(dir, 'home'), parentId: 'g', nodes: [group] })
    store.get().projects.push({ id: 'p1', name: 'P', folder: join(dir, 'proj'), viewport: { x: 0, y: 0, zoom: 1 } })
    for (const ok of [own, plan, project, tree]) await expect(verbs('agent', 'open-doc', { path: ok })).resolves.toMatchObject({ path: ok })
    for (const no of [secret, appData]) await expect(verbs('agent', 'open-doc', { path: no })).rejects.toThrow(/Ask the person to open it/)
    expect(store.get().nodes.filter((n) => n.kind === 'reader').map((n) => (n as ReaderNode).path)).toEqual([own, plan, project, tree])
  })

  it('refuses agents in an archived project, and readers in one', async () => {
    const reader: ReaderNode = { id: 'r', kind: 'reader', title: 'Plan', path: join(dir, 'plan.md'), x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'p2' }
    const { store, verbs, base } = setup({ nodes: [reader] })
    store.dispatch({ op: 'addEdge', edge: { id: 'e', from: 'agent', to: 'r', kind: 'link' } })
    store.get().projects.push({ id: 'p1', name: 'Live', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }, { id: 'p2', name: 'Old', folder: '', viewport: { x: 0, y: 0, zoom: 1 }, archivedAt: 1 })
    await expect(verbs('agent', 'read', { node: 'r' })).rejects.toThrow(/archived/)
    store.get().projects[0].archivedAt = 2
    await expect(verbs('agent', 'open-doc', { path: join(dir, 'plan.md') })).rejects.toThrow(/archived/)
    expect(base).not.toHaveBeenCalled()
  })

  it('refuses a path the reader may not open', async () => {
    const { verbs } = setup()
    await expect(verbs('agent', 'open-doc', { path: join(dir, 'secret.exe') })).rejects.toThrow(/Markdown/)
    await expect(verbs('agent', 'open-doc', {})).rejects.toThrow(/--path is required/)
  })

  it('reads a reader as the file and the open comments, for agents that may', async () => {
    const { store, verbs, comments } = setup()
    const { id } = (await verbs('agent', 'open-doc', { path: join(dir, 'plan.md') })) as { id: string }
    await comments.set(join(dir, 'plan.md'), [
      { id: 'c1', anchor: { section: ['Plan', 'Rollout'], quote: 'Every user at once.' }, text: 'Batches of 100.', createdAt: 1, resolved: false },
      { id: 'c2', anchor: null, text: 'Done already.', createdAt: 2, resolved: true }
    ])
    const r = (await verbs('agent', 'read', { node: id })) as { text: string }
    expect(r.text).toContain('Every user at once.')
    expect(r.text).toContain('1. In "Plan > Rollout", on: "Every user at once."\n   Batches of 100.')
    expect(r.text).not.toContain('Done already')
    expect(r.text).toContain('1 of them not sent to anyone yet.')
    await expect(verbs('other', 'read', { node: id })).rejects.toThrow(/isn't linked to you/)
    expect(store.get().nodes).toHaveLength(3)
  })

  it('passes every other verb through', async () => {
    const { verbs, base } = setup()
    expect(await verbs('agent', 'read', { node: 'other' })).toBe('passed through')
    expect(await verbs('agent', 'list', {})).toBe('passed through')
    expect(base).toHaveBeenCalledTimes(2)
  })
})
