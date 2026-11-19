import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createSubagentWatcher, watchedParents, type SubagentWatcher, type WatchedParent } from '../../src/main/subagents/watcher'
import { readSubagentTranscript } from '../../src/main/subagents/transcript'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'
import type { SubagentSnapshot } from '../../src/shared/subagents'

let root: string
let transcript: string
let dir: string
let watcher: SubagentWatcher | null = null
let parent: WatchedParent
let pushed: SubagentSnapshot[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patchbay subagents '))
  transcript = join(root, 'sess-1.jsonl')
  writeFileSync(transcript, '')
  dir = join(root, 'sess-1', 'subagents')
  parent = { nodeId: 'n1', transcriptPath: transcript, busy: true, exited: false }
  pushed = []
})

afterEach(() => {
  watcher?.close()
  watcher = null
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const start = (now?: () => number): SubagentWatcher => {
  watcher = createSubagentWatcher({ parents: () => [parent], push: (s) => pushed.push(s), everyMs: 0, now })
  return watcher
}

const line = (o: unknown): string => `${JSON.stringify(o)}\n`
const at = (ms: number): string => new Date(ms).toISOString()

function spawnAgent(id: string, meta: Record<string, unknown> = { agentType: 'Explore', description: 'Map the code', spawnDepth: 1 }, when = Date.now()): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta))
  writeFileSync(join(dir, `agent-${id}.jsonl`), line({ type: 'user', isSidechain: true, timestamp: at(when), message: { content: 'Look around\nmore' } }))
}
const toolCall = (id: string, name: string, tokens: number, when = Date.now()): void =>
  appendFileSync(join(dir, `agent-${id}.jsonl`), line({ type: 'assistant', isSidechain: true, timestamp: at(when), message: { id: `m-${name}-${tokens}`, content: [{ type: 'tool_use', name }], usage: { input_tokens: tokens } } }))
const finish = (id: string, extra: Record<string, unknown> = {}): void =>
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Map the code', spawnDepth: 1, finished: true, ...extra }))

test('a subagent shows as running, counts its tools and tokens, then finishes', async () => {
  const w = start()
  await w.tick()
  expect(w.snapshot()).toEqual({})
  spawnAgent('a1')
  await w.tick()
  expect(w.snapshot().n1).toMatchObject({ ran: 1, cards: [{ id: 'a1', parentId: 'n1', agentType: 'Explore', description: 'Map the code', status: 'running', tools: 0, depth: 1 }] })
  toolCall('a1', 'Read', 1200)
  toolCall('a1', 'Grep', 3400)
  await w.tick()
  expect(w.snapshot().n1.cards[0]).toMatchObject({ tools: 2, tokens: 3400, status: 'running' })
  finish('a1')
  await w.tick()
  const card = w.snapshot().n1.cards[0]
  expect(card.status).toBe('done')
  expect(card.endedAt).toBeTypeOf('number')
  // Pushed only when something changed.
  const count = pushed.length
  await w.tick()
  expect(pushed.length).toBe(count)
})

test('a half-written line waits for the rest', async () => {
  const w = start()
  spawnAgent('a1')
  const full = line({ type: 'assistant', timestamp: at(Date.now()), message: { content: [{ type: 'tool_use', name: 'Bash' }], usage: { output_tokens: 7 } } })
  appendFileSync(join(dir, 'agent-a1.jsonl'), full.slice(0, 30))
  await w.tick()
  expect(w.snapshot().n1.cards[0].tools).toBe(0)
  appendFileSync(join(dir, 'agent-a1.jsonl'), full.slice(30))
  await w.tick()
  expect(w.snapshot().n1.cards[0].tools).toBe(1)
})

test('an API error or a stop makes a card failed', async () => {
  const w = start()
  await w.tick()
  spawnAgent('bad')
  spawnAgent('stopped')
  appendFileSync(join(dir, 'agent-bad.jsonl'), line({ type: 'assistant', isApiErrorMessage: true, timestamp: at(Date.now()), message: { content: [{ type: 'text', text: 'Rate limited.' }] } }))
  finish('bad')
  writeFileSync(join(dir, 'agent-stopped.meta.json'), JSON.stringify({ agentType: 'Explore', stoppedByUser: true }))
  await w.tick()
  const cards = Object.fromEntries(w.snapshot().n1.cards.map((c) => [c.id, c]))
  expect(cards.bad).toMatchObject({ status: 'failed', failure: 'Rate limited.' })
  expect(cards.stopped).toMatchObject({ status: 'failed', failure: 'Stopped' })
})

test('subagents finished in an earlier turn are never shown or read', async () => {
  const old = Date.now() - 3600_000
  spawnAgent('past', { agentType: 'Explore', finished: true }, old)
  utimesSync(join(dir, 'agent-past.jsonl'), old / 1000, old / 1000)
  const w = start()
  await w.tick()
  expect(w.snapshot()).toEqual({})
  spawnAgent('now')
  await w.tick()
  expect(w.snapshot().n1.cards.map((c) => c.id)).toEqual(['now'])
})

test('a new turn drops the last turn’s finished cards but keeps one still running', async () => {
  let clock = Date.now()
  const w = start(() => clock)
  await w.tick()
  spawnAgent('done1', undefined, clock + 10)
  spawnAgent('long', undefined, clock + 20)
  finish('done1')
  clock += 1000
  await w.tick()
  expect(w.snapshot().n1.ran).toBe(2)
  clock += 60_000
  w.turnStarted('n1')
  await w.tick()
  expect(w.snapshot().n1).toMatchObject({ ran: 1, cards: [{ id: 'long', status: 'running' }] })
})

test('an idle window is not looked at, unless a subagent of it is still running', async () => {
  parent.busy = false
  const w = start()
  spawnAgent('a1')
  await w.tick()
  expect(w.snapshot()).toEqual({})
  parent.busy = true
  await w.tick()
  expect(w.snapshot().n1.cards[0].status).toBe('running')
  // Background agents outlive the turn that started them.
  parent.busy = false
  toolCall('a1', 'Read', 50)
  await w.tick()
  expect(w.snapshot().n1.cards[0].tools).toBe(1)
})

test('when the session ends, its running subagents fail', async () => {
  const w = start()
  spawnAgent('a1')
  await w.tick()
  parent.exited = true
  parent.busy = false
  await w.tick()
  expect(w.snapshot().n1.cards[0]).toMatchObject({ status: 'failed', failure: 'The session ended' })
})

test('a runaway fan-out is bounded: at most 50 cards are sent, and the count covers all', async () => {
  const w = start()
  for (let i = 0; i < 70; i++) spawnAgent(`a${i}`)
  await w.tick()
  await w.tick()
  await w.tick()
  const group = w.snapshot().n1
  expect(group.ran).toBe(70)
  expect(group.cards.length).toBe(50)
})

test('a closed window is forgotten', async () => {
  const parents: WatchedParent[] = [parent]
  watcher = createSubagentWatcher({ parents: () => parents, push: (s) => pushed.push(s), everyMs: 0 })
  spawnAgent('a1')
  await watcher.tick()
  expect(Object.keys(watcher.snapshot())).toEqual(['n1'])
  parents.length = 0
  await watcher.tick()
  expect(watcher.snapshot()).toEqual({})
})

test('only Claude windows with a transcript are followed; Codex has no subagent folder', () => {
  const node = (id: string, extra: Partial<CanvasNode>): CanvasNode =>
    ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: '.', sessionId: 's', transcriptPath: `C:/t/${id}.jsonl`, after: [], ...extra }) as CanvasNode
  const doc = { nodes: [node('c', {}), node('x', { agent: 'codex' } as Partial<CanvasNode>), node('none', { transcriptPath: null } as Partial<CanvasNode>), node('t', { kind: 'terminal' } as Partial<CanvasNode>)] } as CanvasDoc
  const status: Record<string, string> = { c: 'needs-you' }
  const list = watchedParents({ get: () => doc } as never, (id) => (status[id] ?? 'idle') as never)
  expect(list).toEqual([{ nodeId: 'c', transcriptPath: 'C:/t/c.jsonl', busy: true, exited: false }])
})

test('cards never reach the canvas document: the watcher only reads the store', async () => {
  const doc = { nodes: [{ id: 'n1', kind: 'claude', cwd: '.', transcriptPath: transcript, after: [] }] } as unknown as CanvasDoc
  const before = JSON.stringify(doc)
  const store = { get: () => doc, dispatch: () => { throw new Error('a subagent card tried to change the canvas') } }
  watcher = createSubagentWatcher({ parents: () => watchedParents(store as never, () => 'working'), push: (s) => pushed.push(s), everyMs: 0 })
  spawnAgent('a1')
  await watcher.tick()
  expect(watcher.snapshot().n1.cards).toHaveLength(1)
  expect(JSON.stringify(doc)).toBe(before)
})

test('the transcript viewer reads only what was added since it last looked', async () => {
  spawnAgent('a1')
  const file = join(dir, 'agent-a1.jsonl')
  expect(await readSubagentTranscript(file)).toBe('[prompt]\nLook around\nmore\n')
  appendFileSync(file, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Found it' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } }) + '{"partial')
  expect(await readSubagentTranscript(file)).toBe('[prompt]\nLook around\nmore\n\n[assistant]\nFound it\n\n[Read] a.ts\n')
})
