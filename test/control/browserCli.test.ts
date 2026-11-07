import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { startControlServer, tokenFor, type ControlServer } from '../../src/main/control/server'
import { cleanEnv } from '../../src/main/sessions/env'

const CLI = join(resolve('resources/cli'), 'patchbay.cjs')
const SECRET = 'browser-cli-secret'
let dir: string
let server: ControlServer
let calls: Array<[string, Record<string, unknown>]>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay browser cli '))
  calls = []
  server = await startControlServer({
    secret: SECRET,
    endpointFile: join(dir, 'endpoint.json'),
    onHook: () => ({}),
    onRpc: async (_caller, verb, args) => {
      calls.push([verb, args])
      return { ok: true }
    }
  })
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const cli = (args: string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((done) => {
    const env = cleanEnv(process.env, { PATCHBAY_NODE_ID: 'n1', PATCHBAY_TOKEN: tokenFor(SECRET, 'n1'), PATCHBAY_ENDPOINT_FILE: join(dir, 'endpoint.json') })
    execFile(process.execPath, [CLI, ...args], { env, cwd: dir, windowsHide: true, timeout: 20000 }, (e, _out, stderr) =>
      done({ code: e ? ((e as { code?: number }).code ?? -1) : 0, stderr })
    )
  })

test('browser verbs are two words, and take flags and negative numbers', async () => {
  await cli(['browser', 'type', '--node', 'b', '--ref', 'e2', '--text', 'hi', '--clear', '--enter'])
  await cli(['browser', 'scroll', '--node', 'b', '--by', '-300'])
  await cli(['open-browser', '--url', 'http://localhost:3000'])
  expect(calls).toEqual([
    ['browser-type', { node: 'b', ref: 'e2', text: 'hi', clear: true, enter: true }],
    ['browser-scroll', { node: 'b', by: -300 }],
    ['open-browser', { url: 'http://localhost:3000' }]
  ])
})

test('there is no cookie or script verb, and a flag takes no value', async () => {
  for (const sub of ['cookies', 'eval', 'evaluate']) {
    const r = await cli(['browser', sub, '--node', 'b'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`Unknown verb "browser ${sub}"`)
  }
  expect((await cli(['browser', 'type', '--node', 'b', '--clear=yes'])).code).toBe(1)
  expect(calls).toHaveLength(0)
})
