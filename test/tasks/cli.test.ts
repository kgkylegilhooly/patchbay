import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vitest'
import { createTaskService } from '../../src/main/tasks/service'
import { taskVerb } from '../../src/main/tasks/verbs'
import { startControlServer, tokenFor } from '../../src/main/control/server'
import { cleanEnv } from '../../src/main/sessions/env'
import { claudeNode, memoryStore } from '../control/fakes'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

test('CLI task verbs parse, execute through authenticated RPC, and preserve actionable refusals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patchbay-task-cli-'))
  const endpointFile = join(dir, 'endpoint.json')
  const caller = claudeNode('me', { projectId: 'p', cwd: dir })
  const store = memoryStore([caller])
  store.dispatch({ op: 'addProject', project: { id: 'p', name: 'Tasks', folder: dir, viewport: { x: 0, y: 0, zoom: 1 } } })
  const tasks = createTaskService(store, dir, async () => {}, async () => ({ revision: 'abc', fingerprint: 'tree', uncommitted: false }))
  const server = await startControlServer({ secret: 'task-test', endpointFile, onHook: () => ({}), onRpc: (_caller, verb, args) => taskVerb(tasks, caller, verb, args) })
  const env = cleanEnv(process.env, { PATCHBAY_NODE_ID: 'me', PATCHBAY_TOKEN: tokenFor('task-test', 'me'), PATCHBAY_ENDPOINT_FILE: endpointFile })
  const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [resolve('resources/cli/patchbay.cjs'), 'task', ...args], { env, windowsHide: true })).stdout
  try {
    expect(await cli('--help')).toContain('task verify')
    const task = JSON.parse(await cli('create', '--brief', 'CLI outcome', '--criteria', 'Exit zero', '--criteria', 'Handles 1,000 rows', '--cwd', dir, '--checks', JSON.stringify([{ id: 'check', command: 'echo actual-command' }])))
    expect(task.acceptanceCriteria).toEqual(['Exit zero', 'Handles 1,000 rows'])
    expect(JSON.parse(await cli('list'))[0].id).toBe(task.id)
    await expect(cli('verify', '--task', task.id, '--check', 'check', '--command', 'evil')).rejects.toMatchObject({ stderr: expect.stringContaining('no --command flag') })
    const attempt = JSON.parse(await cli('verify', '--task', task.id, '--check', 'check'))
    expect(attempt).toMatchObject({ kind: 'command', status: 'running', command: 'echo actual-command' })
    await vi.waitFor(async () => expect((await tasks.show('p', task.id)).attempts[0]).toMatchObject({ status: 'passed', exitCode: 0 }), { timeout: 30_000 })
    const submitted = JSON.parse(await cli('submit', '--task', task.id, '--summary', 'Executed the command'))
    expect(submitted.attempts.map((a: { kind: string }) => a.kind)).toEqual(['command', 'agent-report'])
    expect(JSON.parse(await cli('show', '--task', task.id)).task.acceptances).toEqual([])
    await expect(cli('state', '--task', task.id, '--state', 'accepted')).rejects.toMatchObject({ stderr: expect.stringContaining('only a person can accept') })
    await expect(cli('show', '--task', 'missing')).rejects.toMatchObject({ stderr: expect.stringContaining('Task not found') })
  } finally {
    await server.close()
    await removeTemp(dir)
  }
})
