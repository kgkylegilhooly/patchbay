import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useProgramRunner, type RunResult } from '../../src/core/git/run'
import { customLaunch, lookUpClaudeAhead } from '../../src/main/sessions/claudeLaunch'

const answer = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: '', truncated: false, timedOut: false, missing: false })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-lookup-'))
})
afterEach(() => {
  useProgramRunner(null)
  rmSync(dir, { recursive: true, force: true })
})

test("a custom agent command's program is found ahead, through the program runner, and starting the agent uses that answer", async () => {
  // A path where.exe could never give, so the launch below shows the answer from ahead was used.
  const exe = join(dir, 'pb-ahead-agent.exe')
  writeFileSync(exe, '')
  const runner = vi.fn(async (_file: string, args: string[]) => (args[0] === 'pb-ahead-agent' ? answer(`${exe}\r\n`) : answer('', 1)))
  useProgramRunner(runner)
  await lookUpClaudeAhead({ command: 'pb-ahead-agent --fast {args}' })
  expect(runner.mock.calls.map((c) => [c[0], c[1][0]])).toEqual(
    expect.arrayContaining([
      ['where.exe', 'claude'],
      ['where.exe', 'pb-ahead-agent']
    ])
  )
  const launch = customLaunch({ command: 'pb-ahead-agent --fast {args}' }, ['hello'])
  expect(launch).toEqual({ file: exe, args: ['--fast', 'hello'] })
})

test('a program that is already known is not asked about again, and one not found is left to be asked about at start', async () => {
  const exe = join(dir, 'pb-known-agent.exe')
  writeFileSync(exe, '')
  const runner = vi.fn(async (_file: string, args: string[]) => (args[0] === 'pb-known-agent' ? answer(exe) : answer('', 1)))
  useProgramRunner(runner)
  await lookUpClaudeAhead({ command: 'pb-known-agent' })
  const asked = runner.mock.calls.length
  await lookUpClaudeAhead({ command: 'pb-known-agent' })
  expect(runner.mock.calls.filter((c) => c[1][0] === 'pb-known-agent')).toHaveLength(1)
  expect(runner.mock.calls.length).toBeGreaterThanOrEqual(asked)
  // Not found ahead: the launch asks where.exe itself, as before, and says it wasn't found.
  useProgramRunner(async () => answer('', 1))
  await lookUpClaudeAhead({ command: 'pb-nowhere-agent-zz' })
  expect(() => customLaunch({ command: 'pb-nowhere-agent-zz' }, [])).toThrow(/was not found/)
})
