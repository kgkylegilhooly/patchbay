import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { takeMissedHooks } from '../../src/main/sessions/missedHooks'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const HOOK = resolve('resources/hook.cjs')
const CLI = resolve('resources/cli/patchbay.cjs')
/** A process number no live process could have: Windows pids are multiples of 4. */
const DEAD_PID = 4194303

let dir: string
let endpoint: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-closed-'))
  endpoint = join(dir, 'endpoint.json')
})
afterEach(() => removeTemp(dir))

function hook(event: Record<string, unknown>, node = 'node/1'): { code: number | null; out: string; ms: number } {
  const started = Date.now()
  const r = spawnSync(process.execPath, [HOOK, String(event.hook_event_name)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 45_000,
    env: { ...process.env, PATCHBAY_ENDPOINT_FILE: endpoint, PATCHBAY_NODE_ID: node, PATCHBAY_TOKEN: 't' }
  })
  return { code: r.status, out: r.stdout, ms: Date.now() - started }
}

const missed = (node = 'node/1') => takeMissedHooks(join(dir, 'missed'), node)

/** A port that counts who connects to it, standing in for an app's old port: it must never be tried. */
async function watchedPort(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let count = 0
  const server: Server = createServer((socket) => {
    count++
    socket.destroy()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as { port: number }).port,
    connections: () => count,
    close: () => new Promise((done) => server.close(() => done()))
  }
}

/** Runs a script without blocking this process, so the watched port can take a connection if one comes. */
function runScript(args: string[], input: string, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', fail)
    child.on('close', (code) => done({ code, out, err }))
    child.stdin.end(input)
  })
}

test('with no endpoint file, a hook journals its event and exits 0 with nothing printed', () => {
  const r = hook({ hook_event_name: 'Stop', session_id: 's' })
  expect(r).toMatchObject({ code: 0, out: '' })
  expect(missed()).toEqual([{ at: expect.any(Number), hook_event_name: 'Stop', session_id: 's' }])
})

test('after a crash, the file naming a dead app is not waited on', async () => {
  // The old port is open here: a hook that tried it would connect. It must see the app is gone and not try.
  const old = await watchedPort()
  try {
    writeFileSync(endpoint, JSON.stringify({ port: old.port, pid: DEAD_PID }))
    const r = await runScript([HOOK, 'Stop'], JSON.stringify({ hook_event_name: 'Stop' }), { PATCHBAY_ENDPOINT_FILE: endpoint, PATCHBAY_NODE_ID: 'node/1', PATCHBAY_TOKEN: 't' })
    expect(r.code).toBe(0)
    expect(old.connections()).toBe(0)
    expect(missed()).toHaveLength(1)
  } finally {
    await old.close()
  }
})

test('a permission request gets no answer, which leaves Claude its own prompt, and its input stays out of the journal', () => {
  const r = hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'secret stuff' } })
  expect(r).toMatchObject({ code: 0, out: '' })
  const [entry] = missed()
  expect(entry.hook_event_name).toBe('PermissionRequest')
  expect(JSON.stringify(entry)).not.toContain('secret stuff')
})

test('events journal in order, separately for each node', () => {
  hook({ hook_event_name: 'PreToolUse' })
  hook({ hook_event_name: 'Stop' })
  hook({ hook_event_name: 'Stop' }, 'other')
  expect(missed().map((e) => e.hook_event_name)).toEqual(['PreToolUse', 'Stop'])
  expect(missed('other')).toHaveLength(1)
})

test('a journal that has grown large rolls over rather than growing for ever, and keeps the newest events', () => {
  const missedDir = join(dir, 'missed')
  mkdirSync(missedDir)
  const file = join(missedDir, `${encodeURIComponent('node/1')}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ hook_event_name: 'PreToolUse' })}\n`.repeat(8000))
  const before = statSync(file).size
  expect(before).toBeGreaterThan(256 * 1024)
  hook({ hook_event_name: 'Stop' })
  expect(statSync(file).size).toBeLessThan(1024)
  expect(existsSync(`${file}.old`)).toBe(true)
  expect(missed().at(-1)?.hook_event_name).toBe('Stop')
})

test('an unwritable journal still lets the hook exit 0', () => {
  writeFileSync(join(dir, 'missed'), 'a file where the folder should go')
  expect(hook({ hook_event_name: 'Stop' }).code).toBe(0)
  expect(readFileSync(join(dir, 'missed'), 'utf8')).toContain('a file')
})

test.each([
  ['no endpoint file', false],
  ['an endpoint naming a dead app', true]
])('the CLI with %s says the app is closed, without trying to reach it', async (_name, dead) => {
  // Fast because nothing is tried: an open old port that is never connected to shows that, however busy the machine.
  const old = await watchedPort()
  try {
    if (dead) writeFileSync(endpoint, JSON.stringify({ port: old.port, pid: DEAD_PID }))
    const r = await runScript([CLI, 'list'], '', { PATCHBAY_ENDPOINT_FILE: endpoint, PATCHBAY_NODE_ID: 'n', PATCHBAY_TOKEN: 't' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/app is closed/)
    expect(r.err).toMatch(/keeps running/)
    expect(old.connections()).toBe(0)
  } finally {
    await old.close()
  }
})
