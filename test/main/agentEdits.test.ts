import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentEditLog } from '../../src/main/agentEdits'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'pb-edits-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('agents\' changes are kept across a restart until the person settles them', async () => {
  const file = join(dir, 'agent-edits.json')
  const log = createAgentEditLog(file)
  log.note({ id: 'n', by: 'lead', before: 'a', after: 'a\nb', at: 1 })
  log.board({ id: 'w', by: 'lead', before: 0, after: 5, at: 2 })
  await log.flush()
  const again = createAgentEditLog(file)
  expect(again.all()).toEqual({ notes: [{ id: 'n', by: 'lead', before: 'a', after: 'a\nb', at: 1 }], boards: [{ id: 'w', by: 'lead', before: 0, after: 5, at: 2 }] })
  again.settle('n')
  await again.flush()
  expect(createAgentEditLog(file).all()).toEqual({ notes: [], boards: [{ id: 'w', by: 'lead', before: 0, after: 5, at: 2 }] })
})

test('a damaged file, or entries that aren\'t edits, start afresh rather than stop the app', () => {
  const file = join(dir, 'agent-edits.json')
  writeFileSync(file, '{oops')
  expect(createAgentEditLog(file).all()).toEqual({ notes: [], boards: [] })
  writeFileSync(file, JSON.stringify({ notes: [{ id: 'n' }, { id: 'n', by: 'x', before: '', after: 'y', at: 1 }], boards: 'no' }))
  expect(createAgentEditLog(file).all()).toEqual({ notes: [{ id: 'n', by: 'x', before: '', after: 'y', at: 1 }], boards: [] })
})
