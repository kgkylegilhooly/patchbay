import { expect, test } from 'vitest'
import { createCodexGate } from '../../src/main/usage/codexGate'

test('a read runs when no Codex session has started lately', async () => {
  const gate = createCodexGate({ settleMs: 1000, now: () => 5000 })
  expect(await gate.read(async () => 'limits')).toBe('limits')
})

test('no read starts while a session is settling, and it says how long to wait', async () => {
  let t = 1000
  const gate = createCodexGate({ settleMs: 1000, now: () => t })
  await gate.sessionStarting()
  t = 1400
  let ran = false
  expect(await gate.read(async () => ((ran = true), 'x'))).toBeUndefined()
  expect(ran).toBe(false)
  expect(gate.waitMs()).toBe(600)
  t = 2000
  expect(await gate.read(async () => 'x')).toBe('x')
})

test('a session starting waits for a read already under way, so the two never set Codex up at once', async () => {
  const gate = createCodexGate({ settleMs: 1000, now: () => 0 })
  let finish = (): void => {}
  const order: string[] = []
  const reading = gate.read(() => new Promise<void>((r) => (finish = r)).then(() => void order.push('read done')))
  const starting = gate.sessionStarting().then(() => void order.push('session starts'))
  await new Promise((r) => setTimeout(r, 20))
  expect(order).toEqual([])
  finish()
  await Promise.all([reading, starting])
  expect(order).toEqual(['read done', 'session starts'])
})

test('a read that fails does not hold a session up', async () => {
  const gate = createCodexGate({ settleMs: 1000, now: () => 0 })
  await expect(gate.read(async () => Promise.reject(new Error('no answer')))).rejects.toThrow('no answer')
  await gate.sessionStarting()
})
