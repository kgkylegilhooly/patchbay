import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { RpcRefusal, startControlServer, tokenFor, type ControlServer } from '../../src/main/control/server'
import { createApprovals } from '../../src/main/sessions/approvals'

const HOOK = resolve('resources/hook.cjs')
const SECRET = 's'
const NODE = 'n1'

let dir: string
let endpointFile: string
let approvals: ReturnType<typeof createApprovals>
let server: ControlServer
let rpcCalls: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay hold '))
  endpointFile = join(dir, 'endpoint.json')
  approvals = createApprovals()
  rpcCalls = []
  server = await startControlServer({
    secret: SECRET,
    endpointFile,
    onHook: async (id, payload, signal) => {
      if (payload.hook_event_name !== 'PermissionRequest') return {}
      return { decision: await approvals.request(id, payload, signal) }
    },
    onRpc: async (_caller, verb) => {
      rpcCalls.push(verb)
      throw new RpcRefusal(`unknown verb ${verb}`)
    }
  })
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function startHook(input: unknown): {
  child: ChildProcessWithoutNullStreams
  finished: Promise<{ code: number | null; stdout: string }>
} {
  const child = spawn(process.execPath, [HOOK, 'PermissionRequest'], {
    env: {
      ...process.env,
      PATCHBAY_ENDPOINT_FILE: endpointFile,
      PATCHBAY_NODE_ID: NODE,
      PATCHBAY_TOKEN: tokenFor(SECRET, NODE)
    }
  })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))
  const finished = new Promise<{ code: number | null; stdout: string }>((done) =>
    child.on('close', (code) => done({ code, stdout }))
  )
  child.stdin.end(JSON.stringify(input))
  return { child, finished }
}

const request = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }
const pendingOne = async () => {
  await vi.waitFor(() => expect(approvals.pending()).toHaveLength(1), { timeout: 5000 })
  return approvals.pending()[0]
}

test('hook.cjs prints allow and deny JSON in the form Claude Code reads', async () => {
  const allow = startHook(request)
  approvals.answer((await pendingOne()).requestId, 'allow')
  const a = await allow.finished
  expect(a.code).toBe(0)
  expect(JSON.parse(a.stdout)).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
  })

  const deny = startHook(request)
  approvals.answer((await pendingOne()).requestId, 'deny')
  const d = await deny.finished
  expect(d.code).toBe(0)
  const output = JSON.parse(d.stdout).hookSpecificOutput
  expect(output.hookEventName).toBe('PermissionRequest')
  expect(output.decision.behavior).toBe('deny')
  expect(output.decision.message).toEqual(expect.any(String))
}, 20000)

test('hook.cjs holds past its usual 2 s limit while waiting for an answer', async () => {
  const hook = startHook(request)
  const { requestId } = await pendingOne()
  await new Promise((r) => setTimeout(r, 2500))
  expect(hook.child.exitCode).toBeNull()
  approvals.answer(requestId, 'allow')
  expect((await hook.finished).stdout).toContain('"allow"')
}, 20000)

test('hook.cjs prints nothing and exits 0 when the request is cleared', async () => {
  const hook = startHook(request)
  await pendingOne()
  approvals.clearNode(NODE)
  expect(await hook.finished).toEqual({ code: 0, stdout: '' })
}, 20000)

test('hook.cjs prints nothing and exits 0 for a question, without holding', async () => {
  const hook = startHook({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: {} })
  expect(await hook.finished).toEqual({ code: 0, stdout: '' })
}, 20000)

test('hook.cjs prints nothing and exits 0 if the server closes mid-hold', async () => {
  const hook = startHook(request)
  await pendingOne()
  await server.close()
  expect(await hook.finished).toEqual({ code: 0, stdout: '' })
  approvals.clearNode(NODE)
}, 20000)

test('hook.cjs withholds an oversized tool input, which means no buttons', async () => {
  const hook = startHook({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Write',
    tool_input: { file_path: 'C:/big.txt', content: 'x'.repeat(2 * 1024 * 1024) }
  })
  expect(await hook.finished).toEqual({ code: 0, stdout: '' })
  expect(approvals.pending()).toEqual([])
}, 20000)

test('a killed hook closes its connection, which clears the buttons', async () => {
  const hook = startHook(request)
  await pendingOne()
  hook.child.kill()
  await vi.waitFor(() => expect(approvals.pending()).toEqual([]), { timeout: 5000 })
}, 20000)

test('no /rpc verb can answer an approval', async () => {
  const hook = startHook(request)
  const { requestId } = await pendingOne()
  for (const verb of ['answerApproval', 'answer', 'approve', 'allow', 'send', 'deny']) {
    const res = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
      method: 'POST',
      headers: { 'x-patchbay-node': NODE, authorization: `Bearer ${tokenFor(SECRET, NODE)}` },
      body: JSON.stringify({ verb, args: { requestId, decision: 'allow' } })
    })
    expect(res.status).toBe(400)
  }
  expect(rpcCalls).toHaveLength(6)
  expect(approvals.pending()).toHaveLength(1)

  // The verbs Task 9 adds live in this folder. None of it may reach the approvals module.
  const control = resolve('src/main/control')
  for (const file of readdirSync(control)) {
    expect(readFileSync(join(control, file), 'utf8'), file).not.toMatch(/approvals|answerApproval/i)
  }

  approvals.clearNode(NODE)
  expect((await hook.finished).stdout).toBe('')
}, 20000)
