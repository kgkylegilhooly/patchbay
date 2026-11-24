import { expect, test, vi } from 'vitest'
import { awaySummary } from '../../src/shared/away'
import type { AwayChanges } from '../../src/shared/filesTouched'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
const { createAway } = await import('../../src/main/files/away')

const changes = (over: Partial<AwayChanges> = {}): AwayChanges => ({ files: ['a.ts', 'b.ts'], moreFiles: 0, commits: ['abc1234 Fix it'], moreCommits: 0, since: 0, shared: [], ...over })

test('a resumed agent with changes gets a strip; Tell it sends the list once and clears it', async () => {
  const pushed: Array<Record<string, AwayChanges>> = []
  const sent: Array<[string, string]> = []
  const away = createAway({ changes: async (id) => (id === 'a' ? changes() : null), send: (id, text) => (sent.push([id, text]), { ok: true }), push: (a) => pushed.push(a) })
  await away.resumed('a')
  await away.resumed('b')
  expect(Object.keys(away.get())).toEqual(['a'])
  expect(pushed).toHaveLength(1)
  expect(away.tell('a')).toEqual({ ok: true })
  expect(sent).toHaveLength(1)
  expect(sent[0][1]).toMatch(/^While you were away[\s\S]*- abc1234 Fix it[\s\S]*- a\.ts\n- b\.ts/)
  expect(away.get()).toEqual({})
  expect(away.tell('a')).toEqual({ ok: false, reason: 'There is nothing to tell it.' })
})

test('Dismiss clears without sending; a send that fails keeps the strip and says why', async () => {
  const away = createAway({ changes: async () => changes(), send: () => ({ ok: false, reason: 'Agent has exited. Restart it first.' }), push: () => {} })
  await away.resumed('a')
  expect(away.tell('a')).toEqual({ ok: false, reason: 'Agent has exited. Restart it first.' })
  expect(Object.keys(away.get())).toEqual(['a'])
  away.dismiss('a')
  expect(away.get()).toEqual({})
})

test('a failed look shows nothing, and the strip line counts files and commits', async () => {
  const away = createAway({ changes: async () => { throw new Error('git broke') }, send: () => ({ ok: true }), push: () => {} })
  await away.resumed('a')
  expect(away.get()).toEqual({})
  expect(awaySummary(changes({ moreFiles: 3, moreCommits: 1 }))).toBe('While it was away: 5 files changed, 2 commits.')
  expect(awaySummary(changes({ files: ['a.ts'], commits: [] }))).toBe('While it was away: 1 file changed.')
})
