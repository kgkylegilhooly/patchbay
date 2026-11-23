import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DENIED } from '../../src/main/sessions/hookPayload'
import { MAX_PARSED_BYTES, startHostHooks, type HookForwarder, type HostHooks } from '../../src/main/sessions/hostHooks'
import { foldMissedHooks, takeMissedHooks } from '../../src/main/sessions/missedHooks'
import { removeTemp } from '../support/realProcess'

let dir: string
let hooks: HostHooks

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay host hooks '))
  hooks = await startHostHooks({ journalDir: join(dir, 'missed'), replyLimitMs: 150, maxHeld: 50 })
  hooks.allow('n1', 'tok1')
  hooks.allow('n2', 'tok2')
})

afterEach(async () => {
  await hooks.close()
  await removeTemp(dir)
})

interface Reply {
  status: number
  body: Record<string, unknown>
  ms: number
}

/** Posts as Claude Code's http hook does: the event as JSON, the node and its token in headers. */
function post(event: string, payload: Record<string, unknown> | string, opts: { node?: string; token?: string; path?: string; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<Reply> {
  const text = typeof payload === 'string' ? payload : JSON.stringify({ hook_event_name: event, session_id: 's1', ...payload })
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: hooks.port,
        method: 'POST',
        path: opts.path ?? `/hook/${event}`,
        headers: { 'content-type': 'application/json', 'x-patchbay-node': opts.node ?? 'n1', authorization: `Bearer ${opts.token ?? 'tok1'}`, ...opts.headers },
        signal: opts.signal
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), ms: Date.now() - started }))
      }
    )
    // A refused request's connection is closed without reading what it sent, which can cut the upload short.
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: -1, body: {}, ms: 0 }) : reject(e)))
    req.end(text)
  })
}

/** An app connected to the host: it records what it's handed and answers when told. */
function fakeApp(): HookForwarder & { got: Array<{ hid: number; id: string; payload: Record<string, unknown>; live: boolean }>; cancelled: number[] } {
  const got: Array<{ hid: number; id: string; payload: Record<string, unknown>; live: boolean }> = []
  const cancelled: number[] = []
  return { got, cancelled, forward: (hid, id, payload, live) => void got.push({ hid, id, payload, live }), cancel: (hid) => void cancelled.push(hid) }
}

const until = async (what: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const journal = (id = 'n1') => takeMissedHooks(join(dir, 'missed'), id)

test('a wrong token or an unknown node is dropped, but answered 200, which Claude shows no error for', async () => {
  const app = fakeApp()
  hooks.connect(app)
  // The last is as Claude sends it when it blanks a credential-like header.
  for (const opts of [{ token: 'tok2' }, { node: 'n3', token: 'tok1' }, { token: '' }]) expect(await post('Stop', {}, opts)).toMatchObject({ status: 200, body: {} })
  hooks.disallow('n1')
  expect((await post('Stop', {})).status).toBe(200)
  expect(app.got).toEqual([])
})

test('anything but POST /hook/<event> from Claude itself is refused and its connection closed', async () => {
  for (const path of ['/rpc', '/hook/../x', '/hook/St%zzop', '/hook/Stop?x=1']) expect((await post('Stop', {}, { path })).status).toBe(404)
  // A web page sends an Origin; one reached by rebinding a name to 127.0.0.1 sends its own Host.
  expect((await post('Stop', {}, { headers: { origin: 'https://example.com' } })).status).toBe(403)
  expect((await post('Stop', {}, { headers: { host: `evil.example:${hooks.port}` } })).status).toBe(403)
  await hooks.flush()
  expect(readJournal()).toEqual([])
})

test('with no app, every event is answered at once with nothing to say, kept for the next app, and journalled when the host stops', async () => {
  const replies = [await post('UserPromptSubmit', { prompt: 'hi' }), await post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }), await post('Stop', {})]
  // Nothing to say: a permission request is left to Claude's own prompt.
  for (const r of replies) expect(r).toMatchObject({ status: 200, body: {} })
  for (const r of replies) expect(r.ms).toBeLessThan(1000)
  // However long the app is away: no timer moves them to a journal a running app might not read until it restarts.
  await new Promise((r) => setTimeout(r, 300))
  expect(readJournal()).toEqual([])
  await hooks.flush()
  const events = journal()
  expect(events.map((e) => e.hook_event_name)).toEqual(['UserPromptSubmit', 'PermissionRequest', 'Stop'])
  // As hook.cjs writes them: no prompt text, no tool input, and when.
  expect(events[1]).not.toHaveProperty('tool_input')
  expect(events[0]).not.toHaveProperty('prompt')
  expect(typeof events[0].at).toBe('number')
  expect(foldMissedHooks(events).status).toBe('idle')
})

function readJournal(id = 'n1'): string[] {
  try {
    return readFileSync(join(dir, 'missed', `${encodeURIComponent(id)}.jsonl`), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

test('an app that connects gets what came meanwhile, in order, with nothing journalled', async () => {
  await post('UserPromptSubmit', {})
  await post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  const app = fakeApp()
  hooks.connect(app)
  expect(app.got.map((g) => [g.payload.hook_event_name, g.live])).toEqual([
    ['UserPromptSubmit', false],
    // Nobody waits on that request now: it comes as the prompt it put up, so the app holds no approval for it.
    ['Notification', false]
  ])
  expect(app.got[1].payload.notification_type).toBe('permission_prompt')
  await new Promise((r) => setTimeout(r, 300))
  expect(readJournal()).toEqual([])
})

test('forwards to the app and answers Claude with its answer, sending only the fields Patchbay uses', async () => {
  const app = fakeApp()
  hooks.connect(app)
  const reply = post('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: 'x'.repeat(5000), cwd: 'C:\\w' })
  await until(() => app.got.length === 1)
  expect(app.got[0]).toMatchObject({ id: 'n1', live: true, payload: { hook_event_name: 'PostToolUse', session_id: 's1', cwd: 'C:\\w' } })
  expect(app.got[0].payload).not.toHaveProperty('tool_response')
  hooks.answer(app.got[0].hid, {})
  expect(await reply).toMatchObject({ status: 200, body: {} })
})

test('a held permission request waits past the reply limit for the person, and their answer reaches Claude', async () => {
  const app = fakeApp()
  hooks.connect(app)
  const allow = post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  await until(() => app.got.length === 1)
  expect(app.got[0].payload.tool_input).toEqual({ command: 'ls' })
  await new Promise((r) => setTimeout(r, 400))
  hooks.answer(app.got[0].hid, { decision: 'allow' })
  expect((await allow).body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

  const deny = post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm' } })
  await until(() => app.got.length === 2)
  hooks.answer(app.got[1].hid, { decision: 'deny' })
  expect((await deny).body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENIED } } })

  const none = post('PermissionRequest', { tool_name: 'Bash' })
  await until(() => app.got.length === 3)
  hooks.answer(app.got[2].hid, { decision: null })
  expect((await none).body).toEqual({})
})

test('Claude giving up on a held request takes back its prompt in the app', async () => {
  const app = fakeApp()
  hooks.connect(app)
  const abort = new AbortController()
  const reply = post('PermissionRequest', { tool_name: 'Bash' }, { signal: abort.signal }).catch(() => null)
  await until(() => app.got.length === 1)
  abort.abort()
  await reply
  await until(() => app.cancelled.length === 1)
  expect(app.cancelled).toEqual([app.got[0].hid])
})

test('a slow app: Claude gets nothing to say by the limit, and the app still gets the event', async () => {
  const app = fakeApp()
  hooks.connect(app)
  const reply = await post('Stop', {})
  expect(reply.body).toEqual({})
  expect(reply.ms).toBeGreaterThanOrEqual(140)
  expect(reply.ms).toBeLessThan(1500)
  expect(app.got.map((g) => g.payload.hook_event_name)).toEqual(['Stop'])
  // Its late answer goes nowhere, and nothing is journalled.
  hooks.answer(app.got[0].hid, {})
  await new Promise((r) => setTimeout(r, 300))
  expect(readJournal()).toEqual([])
})

test("the app going away: a held request is left to Claude, and what it hadn't answered goes to the next app under the same ids", async () => {
  const app = fakeApp()
  hooks.connect(app)
  // One after another, as Claude sends a session's events: two connections at once can arrive either way round.
  const held = post('PermissionRequest', { tool_name: 'Bash' })
  await until(() => app.got.length === 1)
  const stop = post('Stop', {})
  await until(() => app.got.length === 2)
  hooks.disconnect(app)
  expect((await held).body).toEqual({})
  expect((await stop).body).toEqual({})
  const next = fakeApp()
  hooks.connect(next)
  // The same ids, so an app that had applied one before its answer was lost can tell.
  expect(next.got.map((g) => [g.hid, g.payload.hook_event_name, g.live])).toEqual([
    [app.got[0].hid, 'Notification', false],
    [app.got[1].hid, 'Stop', false]
  ])
  await hooks.flush()
  expect(readJournal()).toEqual([])
})

test('an app from before this, which never takes hooks, gets them in the journal it reads', async () => {
  await post('UserPromptSubmit', {})
  hooks.appWithoutHooks(true)
  await until(() => readJournal().length === 1)
  await post('Stop', {})
  await until(() => readJournal().length === 2)
  hooks.appWithoutHooks(false)
  await post('Notification', {})
  await new Promise((r) => setTimeout(r, 100))
  expect(readJournal()).toHaveLength(2)
})

test('past the most it keeps, what waits goes to the journal, in order', async () => {
  for (let i = 0; i < 51; i++) await post(i % 2 ? 'Stop' : 'UserPromptSubmit', {})
  await until(() => readJournal().length === 51)
  expect(journal().at(-1)?.hook_event_name).toBe('UserPromptSubmit')
})

test('a newer connection takes over what the older one hadn\'t answered', async () => {
  const older = fakeApp()
  hooks.connect(older)
  void post('UserPromptSubmit', {})
  await until(() => older.got.length === 1)
  const newer = fakeApp()
  hooks.connect(newer)
  expect(newer.got.map((g) => [g.payload.hook_event_name, g.live])).toEqual([['UserPromptSubmit', false]])
  // The older one's close comes later and changes nothing.
  hooks.disconnect(older)
  const stop = post('Stop', {})
  await until(() => newer.got.length === 2)
  // Answered before the test ends, so no request is still open when the server closes.
  hooks.answer(newer.got[1].hid, {})
  expect((await stop).status).toBe(200)
})

test('events for different nodes go to their own journals, and flush writes at once', async () => {
  await post('UserPromptSubmit', {}, { node: 'n2', token: 'tok2' })
  await post('Stop', {})
  await hooks.flush()
  expect(journal('n1').map((e) => e.hook_event_name)).toEqual(['Stop'])
  expect(journal('n2').map((e) => e.hook_event_name)).toEqual(['UserPromptSubmit'])
})

test('a journal past its size rolls over, and both parts are read', async () => {
  mkdirSync(join(dir, 'missed'), { recursive: true })
  writeFileSync(join(dir, 'missed', 'n1.jsonl'), `${JSON.stringify({ hook_event_name: 'UserPromptSubmit', pad: 'x'.repeat(300 * 1024) })}\n`)
  await post('Stop', {})
  await hooks.flush()
  expect(readFileSync(join(dir, 'missed', 'n1.jsonl.old'), 'utf8')).toContain('UserPromptSubmit')
  expect(journal().map((e) => e.hook_event_name)).toEqual(['UserPromptSubmit', 'Stop'])
})

test('a body too big to parse, or not JSON, still counts as its event, named by the path', async () => {
  const app = fakeApp()
  hooks.connect(app)
  // One after another: sent at once, the small one could overtake the big one, as it did now and then in a full run.
  const big = post('PostToolUse', JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(MAX_PARSED_BYTES + 10) }))
  await until(() => app.got.length === 1)
  const bad = post('Stop', 'not json')
  await until(() => app.got.length === 2)
  expect(app.got.map((g) => g.payload)).toEqual([{ hook_event_name: 'PostToolUse' }, { hook_event_name: 'Stop' }])
  for (const g of app.got) hooks.answer(g.hid, {})
  expect((await big).status).toBe(200)
  expect((await bad).status).toBe(200)
})
