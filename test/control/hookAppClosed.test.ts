import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { takeMissedHooks } from '../../src/main/sessions/missedHooks'

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
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function hook(event: Record<string, unknown>, node = 'node/1'): { code: number | null; out: string; ms: number } {
  const started = Date.now()
  const r = spawnSync(process.execPath, [HOOK, String(event.hook_event_name)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PATCHBAY_ENDPOINT_FILE: endpoint, PATCHBAY_NODE_ID: node, PATCHBAY_TOKEN: 't' }
  })
  return { code: r.status, out: r.stdout, ms: Date.now() - started }
}

const missed = (node = 'node/1') => takeMissedHooks(join(dir, 'missed'), node)

test('with no endpoint file, a hook journals its event and exits 0 with nothing printed', () => {
  const r = hook({ hook_event_name: 'Stop', session_id: 's' })
  expect(r).toMatchObject({ code: 0, out: '' })
  expect(missed()).toEqual([{ hook_event_name: 'Stop', session_id: 's' }])
})

test('after a crash, the file naming a dead app is not waited on', () => {
  writeFileSync(endpoint, JSON.stringify({ port: 1, pid: DEAD_PID }))
  const r = hook({ hook_event_name: 'Stop' })
  expect(r.code).toBe(0)
  expect(r.ms).toBeLessThan(1400) // Its limit for trying to connect is 1500.
  expect(missed()).toHaveLength(1)
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
  ['no endpoint file', null],
  ['an endpoint naming a dead app', { port: 1, pid: DEAD_PID }]
])('the CLI with %s says the app is closed, and fast', (_name, content) => {
  if (content) writeFileSync(endpoint, JSON.stringify(content))
  const started = Date.now()
  const r = spawnSync(process.execPath, [CLI, 'list'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PATCHBAY_ENDPOINT_FILE: endpoint, PATCHBAY_NODE_ID: 'n', PATCHBAY_TOKEN: 't' }
  })
  expect(r.status).toBe(1)
  expect(r.stderr).toMatch(/app is closed/)
  expect(r.stderr).toMatch(/keeps running/)
  expect(Date.now() - started).toBeLessThan(3000)
})
