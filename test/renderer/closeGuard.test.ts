import { expect, test, vi } from 'vitest'
import type { CanvasNode } from '../../src/shared/model'

const asked = vi.hoisted(() => [] as Array<{ spec: Record<string, unknown>; run: () => void }>)
vi.mock('../../src/renderer/shell/confirmStore', () => ({ confirmThen: async (spec: Record<string, unknown>, run: () => void) => void asked.push({ spec, run }) }))
const { closeGuarded, uncommittedQuestion } = await import('../../src/renderer/closeGuard')

const box = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const agent = { ...box, id: 'a', kind: 'claude', title: 'Parser tests', cwd: 'C:\\w', sessionId: null, transcriptPath: null, after: [] } as unknown as CanvasNode
const term = { ...box, id: 't', kind: 'terminal', title: 'Shell', cwd: 'C:\\w' } as unknown as CanvasNode

test('the question names each agent and its files, counting past five; nothing left means no question', () => {
  const q = uncommittedQuestion([
    { title: 'Parser tests', files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'] },
    { title: 'Docs', files: ['README.md'] },
    { title: 'Clean', files: [] }
  ])
  expect(q?.lines).toEqual(['Parser tests left 7 files it edited uncommitted: a.ts, b.ts, c.ts, d.ts, e.ts and 2 more.', 'Docs left 1 file it edited uncommitted: README.md.'])
  expect(uncommittedQuestion([{ title: 'Clean', files: [] }])).toBeNull()
})

test('a terminal, a clean agent, or a failed check closes at once; an agent with uncommitted edits asks first', async () => {
  const closed: string[][] = []
  const close = (ids: string[]) => void closed.push(ids)
  await closeGuarded(['t'], [term, agent], close, { uncommitted: async () => ['x.ts'] })
  await closeGuarded(['a'], [term, agent], close, { uncommitted: async () => [] })
  await closeGuarded(['a'], [term, agent], close, { uncommitted: () => Promise.reject(new Error('no git')) })
  expect(closed).toEqual([['t'], ['a'], ['a']])
  expect(asked).toHaveLength(0)

  await closeGuarded(['a', 't'], [term, agent], close, { uncommitted: async () => ['parser.ts'] })
  expect(closed).toHaveLength(3)
  expect(asked[0].spec).toMatchObject({ title: 'Close windows?', verb: 'Close anyway', cancelLabel: 'Keep', lines: ['Parser tests left 1 file it edited uncommitted: parser.ts.'] })
  asked[0].run()
  expect(closed[3]).toEqual(['a', 't'])
})

test('a check slower than two seconds lets the close go ahead', async () => {
  vi.useFakeTimers()
  try {
    const closed: string[][] = []
    const done = closeGuarded(['a'], [agent], (ids) => void closed.push(ids), { uncommitted: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(2000)
    await done
    expect(closed).toEqual([['a']])
  } finally {
    vi.useRealTimers()
  }
})
