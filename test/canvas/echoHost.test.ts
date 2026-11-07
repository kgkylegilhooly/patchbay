import { expect, test } from 'vitest'
import { createEchoSessionHost } from '../../src/main/stubs'
import type { SessionSpec } from '../../src/shared/contract'

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  nodeId: 'n',
  file: 'x',
  args: [],
  cwd: 'C:/',
  env: {},
  ...over
})

test('input is echoed through onOutput with increasing seq', () => {
  const host = createEchoSessionHost()
  const seen: Array<[string, string, number]> = []
  host.onOutput((id, data, seq) => seen.push([id, data, seq]))
  host.start(spec())
  host.write('n', 'a')
  host.write('n', 'b')
  expect(seen).toEqual([
    ['n', 'a', 1],
    ['n', 'b', 2]
  ])
})

test('snapshot plus later chunks loses and duplicates nothing', () => {
  const host = createEchoSessionHost()
  const later: Array<[string, number]> = []
  host.start(spec())
  host.write('n', 'a')
  const snap = host.snapshot('n')
  expect(snap).toEqual({ data: 'a', seq: 1 })
  host.onOutput((_id, data, seq) => later.push([data, seq]))
  host.write('n', 'b')
  expect(later).toEqual([['b', snap.seq + 1]])
})

test('initialScrollback seeds the snapshot', () => {
  const host = createEchoSessionHost()
  host.start(spec({ initialScrollback: 'old\r\n' }))
  host.write('n', 'x')
  expect(host.snapshot('n').data).toBe('old\r\nx')
})

test('kill fires onExit once and stops the session', async () => {
  const host = createEchoSessionHost()
  const exits: Array<[string, number]> = []
  host.onExit((id, code) => exits.push([id, code]))
  host.start(spec())
  expect(host.isRunning('n')).toBe(true)
  await host.kill('n')
  await host.kill('n')
  expect(host.isRunning('n')).toBe(false)
  expect(exits).toEqual([['n', 0]])
})

test('writing to, resizing or reading an unknown session does nothing harmful', () => {
  const host = createEchoSessionHost()
  host.write('ghost', 'x')
  host.resize('ghost', 80, 24)
  expect(host.isRunning('ghost')).toBe(false)
  expect(host.snapshot('ghost')).toEqual({ data: '', seq: 0 })
})
