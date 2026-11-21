import { expect, test } from 'vitest'
import { createHookRelay, type RelayConnection } from '../../src/main/sessions/hookRelay'
import type { HostMessage } from '../../src/main/sessions/hostProtocol'

function conn(): RelayConnection & { sent: HostMessage[] } {
  const sent: HostMessage[] = []
  return { sent, send: (m) => void sent.push(m) }
}
const hook = (hid: number, id: string, name: string, extra: Record<string, unknown> = {}): HostMessage => ({ t: 'hook', hid, id, payload: { hook_event_name: name, ...extra }, live: true })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

test('takes only hook messages', () => {
  const relay = createHookRelay()
  expect(relay.receive(conn(), { t: 'o', id: 'n1', d: 'x' })).toBe(false)
  expect(relay.receive(conn(), hook(1, 'n1', 'Stop'))).toBe(true)
})

test('what comes before the app is ready waits, then is handled in order and answered', async () => {
  const relay = createHookRelay()
  const c = conn()
  relay.receive(c, hook(1, 'n1', 'UserPromptSubmit'))
  relay.receive(c, hook(2, 'n1', 'Stop'))
  await tick(10)
  expect(c.sent).toEqual([])
  const seen: string[] = []
  relay.serve(async (id, payload) => {
    seen.push(`${id}:${payload.hook_event_name}`)
    return payload.hook_event_name === 'Stop' ? { ok: 1 } : undefined
  })
  await tick(10)
  expect(seen).toEqual(['n1:UserPromptSubmit', 'n1:Stop'])
  expect(c.sent).toEqual([
    { t: 'hook-res', hid: 1, body: {} },
    { t: 'hook-res', hid: 2, body: { ok: 1 } }
  ])
})

test("one node's events are handled one after another, while other nodes don't wait", async () => {
  const relay = createHookRelay()
  const c = conn()
  const log: string[] = []
  relay.serve(async (id, payload) => {
    log.push(`start ${id} ${payload.hook_event_name}`)
    if (payload.hook_event_name === 'UserPromptSubmit') await tick(50)
    log.push(`end ${id} ${payload.hook_event_name}`)
  })
  relay.receive(c, hook(1, 'n1', 'UserPromptSubmit'))
  relay.receive(c, hook(2, 'n1', 'Stop'))
  relay.receive(c, hook(3, 'n2', 'Stop'))
  await tick(100)
  expect(log.indexOf('start n1 Stop')).toBeGreaterThan(log.indexOf('end n1 UserPromptSubmit'))
  expect(log.indexOf('end n2 Stop')).toBeLessThan(log.indexOf('end n1 UserPromptSubmit'))
})

test("a held permission request doesn't hold up its node's next event, and Claude giving up aborts it", async () => {
  const relay = createHookRelay()
  const c = conn()
  let signal: AbortSignal | undefined
  const seen: string[] = []
  relay.serve((_id, payload, s) => {
    seen.push(String(payload.hook_event_name))
    if (payload.hook_event_name !== 'PermissionRequest') return {}
    signal = s
    return new Promise((resolve) => s.addEventListener('abort', () => resolve({ decision: null })))
  })
  relay.receive(c, hook(1, 'n1', 'PermissionRequest'))
  relay.receive(c, hook(2, 'n1', 'Notification', { notification_type: 'permission_prompt' }))
  await tick(150)
  expect(seen).toEqual(['PermissionRequest', 'Notification'])
  relay.receive(c, { t: 'hook-cancel', hid: 1 })
  await tick(10)
  expect(signal?.aborted).toBe(true)
  expect(c.sent).toContainEqual({ t: 'hook-res', hid: 1, body: { decision: null } })
})

test('a closed connection: its waiting events are dropped for the host to send again, and held ones aborted', async () => {
  const relay = createHookRelay()
  const old = conn()
  relay.receive(old, hook(1, 'n1', 'Stop'))
  relay.dropConnection(old)
  const seen: number[] = []
  let signal: AbortSignal | undefined
  relay.serve((_id, payload, s) => {
    seen.push(Number(payload.n ?? 0))
    signal = s
    return new Promise(() => {})
  })
  expect(seen).toEqual([])
  const c = conn()
  relay.receive(c, hook(2, 'n1', 'PermissionRequest', { n: 2 }))
  await tick(10)
  relay.dropConnection(c)
  expect(signal?.aborted).toBe(true)
  expect(c.sent).toEqual([])
})

test('a handler that refuses, as for a hook from another node, answers with nothing', async () => {
  const relay = createHookRelay()
  const c = conn()
  relay.serve(() => Promise.reject(new Error('another node')))
  relay.receive(c, hook(1, 'n1', 'Stop'))
  await tick(10)
  expect(c.sent).toEqual([{ t: 'hook-res', hid: 1, body: {} }])
})

test('an event sent again under the same id, after its answer was lost, is answered without being applied twice', async () => {
  const relay = createHookRelay()
  relay.forHost('host-a')
  const seen: number[] = []
  relay.serve((_id, payload) => void seen.push(Number(payload.n)))
  const first = conn()
  relay.receive(first, hook(7, 'n1', 'Stop', { n: 1 }))
  await tick(10)
  relay.dropConnection(first)
  const second = conn()
  relay.receive(second, { t: 'hook', hid: 7, id: 'n1', payload: { hook_event_name: 'Stop', n: 2 }, live: false })
  await tick(10)
  expect(seen).toEqual([1])
  expect(second.sent).toEqual([{ t: 'hook-res', hid: 7, body: {} }])
  // A new host run numbers its events from the start again, so the same id is a new event there.
  relay.forHost('host-b')
  relay.receive(second, hook(7, 'n1', 'Stop', { n: 3 }))
  await tick(10)
  expect(seen).toEqual([1, 3])
})
