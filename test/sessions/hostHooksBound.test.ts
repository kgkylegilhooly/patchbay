import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startHostHooks, type HostHooks } from '../../src/main/sessions/hostHooks'
import { removeTemp } from '../support/realProcess'

let dir: string
let hooks: HostHooks

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay hooks bound '))
  hooks = await startHostHooks({ journalDir: join(dir, 'missed'), replyLimitMs: 5, maxHeld: 50 })
  hooks.allow('n1', 'tok1')
})
afterEach(async () => {
  await hooks.close()
  await removeTemp(dir)
})

const post = (event: string, extra: Record<string, unknown> = {}): Promise<number> =>
  fetch(`http://127.0.0.1:${hooks.port}/hook/${event}`, {
    method: 'POST',
    headers: { 'x-patchbay-node': 'n1', authorization: 'Bearer tok1' },
    body: JSON.stringify({ hook_event_name: event, session_id: 's1', ...extra })
  }).then((r) => r.status)

test('an app that is connected but never answers is not owed every event: the oldest go to the journal', async () => {
  const forwarded: number[] = []
  hooks.connect({ forward: (hid) => void forwarded.push(hid), cancel: () => {} })
  for (let i = 0; i < 300; i += 25) await Promise.all(Array.from({ length: 25 }, (_, k) => post('PostToolUse', { n: i + k })))
  // Every request was answered by the reply limit, and every event still went to the app.
  expect(forwarded).toHaveLength(300)
  // Held to the limit rather than growing with each event.
  expect(hooks.unanswered()).toBeLessThanOrEqual(50)
  await hooks.flush()
  const journal = readdirSync(join(dir, 'missed')).filter((f) => f.endsWith('.jsonl'))
  expect(journal).toEqual(['n1.jsonl'])
  const lines = readFileSync(join(dir, 'missed', 'n1.jsonl'), 'utf8').trim().split('\n')
  expect(lines.length).toBeGreaterThanOrEqual(250)
  // In the order they happened.
  const names = lines.map((l) => (JSON.parse(l) as { hook_event_name: string }).hook_event_name)
  expect(new Set(names)).toEqual(new Set(['PostToolUse']))
})

test('a permission request Claude is still waiting on is never spilled, and its answer still arrives', async () => {
  let askHid = 0
  hooks.connect({
    forward: (hid, _id, payload) => {
      if (payload.hook_event_name === 'PermissionRequest') askHid = hid
    },
    cancel: () => {}
  })
  const asking = fetch(`http://127.0.0.1:${hooks.port}/hook/PermissionRequest`, {
    method: 'POST',
    headers: { 'x-patchbay-node': 'n1', authorization: 'Bearer tok1' },
    body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } })
  }).then((r) => r.json() as Promise<Record<string, unknown>>)
  await vi.waitFor(() => expect(askHid).toBeGreaterThan(0))
  for (let i = 0; i < 200; i += 25) await Promise.all(Array.from({ length: 25 }, () => post('PostToolUse')))
  expect(hooks.unanswered()).toBeLessThanOrEqual(50)
  hooks.answer(askHid, { decision: 'allow' })
  const answer = await asking
  expect(JSON.stringify(answer)).toContain('allow')
})
