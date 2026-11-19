import { describe, expect, test } from 'vitest'
import {
  addEdit,
  createEditCollector,
  diffBase,
  emptyRecord,
  filesInTurn,
  findOverlaps,
  KEEP_CLOSED_MS,
  MAX_FILES,
  MAX_TURNS,
  normalizePath,
  parseRecords,
  pruneRecords,
  serializeRecords,
  startTurn,
  summarize,
  turnAt,
  type SessionRecord
} from '../../src/main/files/touched'

const W = 'win32' as const
const rec = (id = 'a', cwd = 'C:\\repo'): SessionRecord => emptyRecord(id, cwd, 1000)

const use = (id: string, result: { is_error?: boolean } = {}) =>
  JSON.stringify({ type: 'user', timestamp: '2026-11-19T10:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...result }] } })
const call = (id: string, name: string, input: Record<string, unknown>, at = '2026-11-19T10:00:04.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })

describe('paths', () => {
  test('Git Bash and relative paths become one absolute Windows path', () => {
    expect(normalizePath('C:\\repo', '/c/repo/src/a.ts', W)).toBe('C:\\repo\\src\\a.ts')
    expect(normalizePath('C:\\repo', 'src/a.ts', W)).toBe('C:\\repo\\src\\a.ts')
    expect(normalizePath('C:\\repo', 'c:\\repo\\src\\a.ts', W)).toBe('C:\\repo\\src\\a.ts')
    expect(normalizePath('/home/me/repo', 'src/a.ts', 'linux')).toBe('/home/me/repo/src/a.ts')
  })
})

describe('edits and turns', () => {
  test('an edit belongs to the last turn started before it; earlier ones have none', () => {
    const r = rec()
    addEdit(r, { path: 'early.ts', at: 50, confirmed: true }, W)
    startTurn(r, 100)
    startTurn(r, 200)
    addEdit(r, { path: 'a.ts', at: 150, confirmed: true }, W)
    addEdit(r, { path: 'b.ts', at: 250, confirmed: true }, W)
    expect(r.files.map((f) => [f.path, f.firstTurn])).toEqual([
      ['C:\\repo\\early.ts', null],
      ['C:\\repo\\a.ts', 1],
      ['C:\\repo\\b.ts', 2]
    ])
    expect(turnAt(r.turns, 99)).toBeNull()
    expect(filesInTurn(r, 2).map((f) => f.path)).toEqual(['C:\\repo\\b.ts'])
  })

  test('the same file again updates one entry; the same edit read twice changes nothing', () => {
    const r = rec()
    startTurn(r, 100)
    expect(addEdit(r, { path: 'a.ts', at: 150, confirmed: false }, W)).toBe(true)
    expect(addEdit(r, { path: 'A.TS', at: 150, confirmed: false }, W)).toBe(false)
    // Confirmation of the same edit upgrades it.
    expect(addEdit(r, { path: 'a.ts', at: 150, confirmed: true }, W)).toBe(true)
    startTurn(r, 300)
    expect(addEdit(r, { path: 'a.ts', at: 350, confirmed: true }, W)).toBe(true)
    expect(r.files).toHaveLength(1)
    expect(r.files[0]).toMatchObject({ edits: 2, firstTurn: 1, lastTurn: 2, confirmed: true, firstAt: 150, lastAt: 350 })
  })

  test('the list keeps the newest files and says it was cut', () => {
    const r = rec()
    for (let i = 0; i <= MAX_FILES; i++) addEdit(r, { path: `f${i}.ts`, at: 1000 + i, confirmed: true }, W)
    expect(r.files).toHaveLength(MAX_FILES)
    expect(r.truncated).toBe(true)
    expect(r.files.some((f) => f.path.endsWith('f0.ts'))).toBe(false)
  })

  test('turns are kept up to a limit, numbered on', () => {
    const r = rec()
    for (let i = 0; i < MAX_TURNS + 5; i++) startTurn(r, i)
    expect(r.turns).toHaveLength(MAX_TURNS)
    expect(r.turns.at(-1)?.turn).toBe(MAX_TURNS + 5)
  })

  test('a diff starts from the latest turn, or from the turn that first touched the file, if it has a snapshot', () => {
    const r = rec()
    const one = startTurn(r, 100)
    one.tree = 'tree1'
    addEdit(r, { path: 'a.ts', at: 150, confirmed: true }, W)
    const two = startTurn(r, 200)
    two.tree = 'tree2'
    const file = r.files[0]
    expect(diffBase(r, file, 'turn')?.tree).toBe('tree2')
    expect(diffBase(r, file, 'session')?.tree).toBe('tree1')
    one.tree = null
    expect(diffBase(r, file, 'session')).toBeNull()
  })
})

describe('the transcript', () => {
  test('a succeeded edit is confirmed, a failed one dropped, an unanswered one waits for the turn to end', () => {
    const c = createEditCollector()
    c.line(call('t1', 'Edit', { file_path: 'C:\\repo\\ok.ts' }), 0)
    c.line(call('t2', 'Write', { file_path: 'C:\\repo\\bad.ts' }), 100)
    c.line(call('t3', 'MultiEdit', { file_path: 'C:\\repo\\open.ts' }), 200)
    c.line(use('t1'), 300)
    c.line(use('t2', { is_error: true }), 400)
    const now = c.take(false, 9)
    expect(now).toEqual([{ path: 'C:\\repo\\ok.ts', at: Date.parse('2026-11-19T10:00:04.000Z'), confirmed: true }])
    // Reading again from here would find the open one.
    expect(c.safeOffset(500)).toBe(200)
    expect(c.take(true, 9)).toEqual([{ path: 'C:\\repo\\open.ts', at: Date.parse('2026-11-19T10:00:04.000Z'), confirmed: false }])
    expect(c.safeOffset(500)).toBe(500)
  })

  test('Codex patches count, by their own paths', () => {
    const c = createEditCollector()
    c.line(JSON.stringify({ type: 'response_item', timestamp: '2026-11-19T10:00:00.000Z', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch' } }), 0)
    c.line(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p1', output: JSON.stringify({ output: 'Success. Updated the following files:', metadata: { exit_code: 0 } }) } }), 10)
    expect(c.take(false, 0).map((e) => [e.path, e.confirmed])).toEqual([
      ['src/a.ts', true],
      ['src/b.ts', true]
    ])
  })

  test('a Bash command is not an edit', () => {
    const c = createEditCollector()
    c.line(call('b1', 'Bash', { command: 'echo hi > a.txt' }), 0)
    c.line(use('b1'), 10)
    expect(c.take(true, 0)).toEqual([])
  })
})

describe('overlaps, summary and pruning', () => {
  const two = (): SessionRecord[] => {
    const a = rec('a')
    const b = rec('b')
    addEdit(a, { path: 'shared.ts', at: 1, confirmed: true }, W)
    addEdit(a, { path: 'mine.ts', at: 2, confirmed: true }, W)
    addEdit(b, { path: 'C:\\REPO\\Shared.ts', at: 3, confirmed: true }, W)
    return [a, b]
  }

  test('the same file edited by two live sessions is shared, whatever its case on Windows', () => {
    const titles: Record<string, string> = { a: 'Agent A', b: 'Agent B' }
    const o = findOverlaps(two(), (id) => titles[id] ?? null, W)
    expect(o.get('a')).toEqual({ 'C:\\repo\\shared.ts': [{ nodeId: 'b', title: 'Agent B' }] })
    expect(Object.values(o.get('b') ?? {})).toEqual([[{ nodeId: 'a', title: 'Agent A' }]])
    expect(summarize(two(), o)).toEqual({ a: { count: 2, overlap: 1 }, b: { count: 1, overlap: 1 } })
  })

  test('a session that is not live shares nothing', () => {
    const o = findOverlaps(two(), (id) => (id === 'a' ? 'Agent A' : null), W)
    expect(o.size).toBe(0)
  })

  test('records of nodes gone from the canvas are kept a while, then dropped', () => {
    const records = new Map([
      ['a', rec('a')],
      ['b', rec('b')]
    ])
    expect(pruneRecords(records, new Set(['a']), 1000 + KEEP_CLOSED_MS)).toEqual([])
    expect(pruneRecords(records, new Set(['a']), 1001 + KEEP_CLOSED_MS)).toEqual(['b'])
    expect(records.get('a')?.seenAt).toBe(1001 + KEEP_CLOSED_MS)
  })

  test('records survive a save, and damaged ones are left out', () => {
    const [a] = two()
    startTurn(a, 5).tree = 'abc'
    const back = parseRecords(serializeRecords(new Map([['a', a]])))
    expect(back.get('a')).toEqual(a)
    expect(parseRecords('{"sessions":[{"nodeId":1},null,{"nodeId":"x","cwd":"C:\\\\x","files":[{"path":3}]}]}').get('x')?.files).toEqual([])
    expect(parseRecords('not json').size).toBe(0)
    expect(parseRecords(null).size).toBe(0)
  })
})
