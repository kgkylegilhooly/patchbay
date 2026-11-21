import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startControlServer, tokenFor } from '../../src/main/control/server'
import { buildClaudeLaunch, type CommandHook } from '../../src/main/sessions/claudeLaunch'
import { takeMissedHooks } from '../../src/main/sessions/missedHooks'
import type { ClaudeNode } from '../../src/shared/model'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

// Runs the hooks in the settings Patchbay writes, the way Claude Code runs them, against a real control server and
// with no app at all. Both forms: the new one, where Claude starts Node itself, and the command line every session
// started before it still has until it restarts.

const HOOK = resolve('resources/hook.cjs')
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SECRET = 'test-secret'
const NODE_ID = 'node/1'

let dir: string
let endpointFile: string
const closers: Array<() => Promise<void>> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-delivery-'))
  endpointFile = join(dir, 'control', 'endpoint.json')
})
afterEach(async () => {
  while (closers.length) await closers.pop()?.()
  await removeTemp(dir)
})

const node: ClaudeNode = { id: NODE_ID, kind: 'claude', title: 'C', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: '.', sessionId: null, transcriptPath: null, after: [] }

function settingsHooks(hookNode: string | null): Record<string, CommandHook> {
  const launch = buildClaudeLaunch(node, {
    sessionDir: join(dir, 'sessions'),
    hookScript: HOOK,
    pluginDir: join(dir, 'skill'),
    cliDir: join(dir, 'cli'),
    endpointFile,
    token: tokenFor(SECRET, NODE_ID),
    claude: { file: 'C:\\bin\\claude.exe', prefixArgs: [] },
    hookNode
  })
  const file = launch.args[launch.args.indexOf('--settings') + 1]
  const { hooks } = JSON.parse(readFileSync(file, 'utf8'))
  return Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [event, (groups as Array<{ hooks: CommandHook[] }>)[0].hooks[0]]))
}

/** As Claude Code does: with `args`, the program itself; without, the line through Git Bash. */
function runAsClaude(entry: CommandHook, event: Record<string, unknown>): Promise<{ code: number | null; out: string }> {
  const env = { ...process.env, PATCHBAY_ENDPOINT_FILE: endpointFile, PATCHBAY_NODE_ID: NODE_ID, PATCHBAY_TOKEN: tokenFor(SECRET, NODE_ID) }
  const child = entry.args ? spawn(entry.command, entry.args, { env, windowsHide: true }) : spawn(GIT_BASH, ['-c', entry.command], { env, windowsHide: true })
  return new Promise((done, fail) => {
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', fail)
    child.on('close', (code) => done({ code, out }))
    child.stdin.end(JSON.stringify(event))
  })
}

const FORMS = [
  ['started directly', process.execPath],
  // Only where Git Bash is, as Claude Code needs it for a command line on Windows.
  ...(existsSync(GIT_BASH) ? [['as a command line, as sessions from before have it', null] as const] : [])
] as const

async function app() {
  const onHook = vi.fn(async (_id: string, payload: Record<string, unknown>) => {
    if (payload.hook_event_name === 'SessionStart') return { context: 'You are node 1 on the canvas.' }
    if (payload.hook_event_name === 'PermissionRequest') {
      // Held past hook.cjs's own 1.5 s limit, as a person thinking it over would.
      await new Promise((r) => setTimeout(r, 2000))
      return { decision: 'allow' }
    }
    return {}
  })
  const server = await startControlServer({ secret: SECRET, endpointFile, onHook, onRpc: vi.fn(async () => 'ok') })
  closers.push(() => server.close())
  return onHook
}

test.each(FORMS)('%s, every event reaches a running app', async (_label, hookNode) => {
  const onHook = await app()
  const hooks = settingsHooks(hookNode)
  for (const name of ['UserPromptSubmit', 'Stop', 'Notification', 'StopFailure', 'SessionEnd']) {
    const r = await runAsClaude(hooks[name], { hook_event_name: name, session_id: 's', notification_type: 'idle_prompt' })
    expect(r).toEqual({ code: 0, out: '' })
  }
  expect(onHook.mock.calls.map(([id, p]) => [id, p.hook_event_name])).toEqual(
    ['UserPromptSubmit', 'Stop', 'Notification', 'StopFailure', 'SessionEnd'].map((n) => [NODE_ID, n])
  )
})

test.each(FORMS)('%s, SessionStart hands the agent its context and a held permission request its answer', async (_label, hookNode) => {
  await app()
  const hooks = settingsHooks(hookNode)
  const start = await runAsClaude(hooks.SessionStart, { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' })
  expect(JSON.parse(start.out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'You are node 1 on the canvas.' } })
  const asked = await runAsClaude(hooks.PermissionRequest, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(JSON.parse(asked.out)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
})

test.each(FORMS)('%s, with no app running, each event goes in the journal for the app to read later', async (_label, hookNode) => {
  const hooks = settingsHooks(hookNode)
  for (const name of ['UserPromptSubmit', 'Stop']) {
    expect(await runAsClaude(hooks[name], { hook_event_name: name, session_id: 's' })).toEqual({ code: 0, out: '' })
  }
  expect(takeMissedHooks(join(dir, 'control', 'missed'), NODE_ID)).toEqual([
    { hook_event_name: 'UserPromptSubmit', session_id: 's', at: expect.any(Number) },
    { hook_event_name: 'Stop', session_id: 's', at: expect.any(Number) }
  ])
})
