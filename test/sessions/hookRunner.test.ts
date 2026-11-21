import { beforeEach, expect, test, vi } from 'vitest'
import { claudeRunsExecHooks, forgetHookRunners, hookNode, hookNodeFor, parseClaudeVersion, runsExecHooks } from '../../src/main/sessions/hookRunner'

beforeEach(() => forgetHookRunners())

const CLAUDE = { file: 'C:\\bin\\claude.exe', prefixArgs: [] }

test('reads the version Claude Code prints', () => {
  expect(parseClaudeVersion('2.1.330 (Claude Code)\n')).toEqual([2, 1, 330])
  expect(parseClaudeVersion('not a version')).toBeNull()
})

test('starts hooks directly from Claude Code 2.1.139, which added exec form', () => {
  expect(runsExecHooks([2, 1, 138])).toBe(false)
  expect(runsExecHooks([2, 1, 139])).toBe(true)
  expect(runsExecHooks([2, 1, 330])).toBe(true)
  expect(runsExecHooks([2, 2, 0])).toBe(true)
  expect(runsExecHooks([3, 0, 0])).toBe(true)
  expect(runsExecHooks([2, 0, 999])).toBe(false)
  expect(runsExecHooks([1, 9, 999])).toBe(false)
  expect(runsExecHooks(null)).toBe(false)
})

test('asks a program its version once per app run, however many nodes start with it', async () => {
  const ask = vi.fn(async () => '2.1.330 (Claude Code)')
  const answers = await Promise.all([1, 2, 3].map(() => claudeRunsExecHooks({ claude: CLAUDE }, ask)))
  expect(answers).toEqual([true, true, true])
  expect(ask).toHaveBeenCalledTimes(1)
  expect(ask).toHaveBeenCalledWith('C:\\bin\\claude.exe', ['--version'])
})

test('anything unclear keeps the command line: an old Claude, no answer, or another terminal program', async () => {
  expect(await claudeRunsExecHooks({ claude: CLAUDE }, async () => '2.1.100 (Claude Code)')).toBe(false)
  forgetHookRunners()
  expect(await claudeRunsExecHooks({ claude: CLAUDE }, async () => Promise.reject(new Error('ENOENT')))).toBe(false)
  const ask = vi.fn(async () => '2.1.330 (Claude Code)')
  // Inside wsl.exe or the like, Claude may not be on Windows at all.
  expect(await claudeRunsExecHooks({ claudeTerminal: 'wsl.exe', claudeCommand: 'claude' }, ask)).toBe(false)
  expect(await claudeRunsExecHooks({}, ask)).toBe(false)
  expect(ask).not.toHaveBeenCalled()
})

test('a custom Claude command is asked the way it will be launched', async () => {
  const ask = vi.fn(async () => '2.1.330 (Claude Code)')
  expect(await claudeRunsExecHooks({ claudeCommand: `"${process.execPath}" fake-claude.cjs` }, ask)).toBe(true)
  expect(ask).toHaveBeenCalledWith(process.execPath, ['fake-claude.cjs', '--version'])
})

test('Node is the program behind whatever `node` the PATH gives, asked once', async () => {
  const ask = vi.fn(async (_file: string, args: string[]) => (args.includes('process.execPath') ? `${process.execPath}\r\n` : ''))
  expect(await hookNode(ask)).toBe(process.execPath)
  expect(await hookNode(ask)).toBe(process.execPath)
  expect(ask).toHaveBeenCalledTimes(1)
  expect(ask).toHaveBeenCalledWith('node', ['-p', 'process.execPath'])
})

test('no Node, or one that has gone, keeps the command line and is looked for again next time', async () => {
  const gone = vi.fn(async () => 'C:\\nowhere\\node.exe')
  expect(await hookNode(gone)).toBeNull()
  expect(await hookNode(gone)).toBeNull()
  expect(gone).toHaveBeenCalledTimes(2)
  expect(await hookNode(async () => Promise.reject(new Error('not found')))).toBeNull()
})

test('hookNodeFor gives a Node only for a Claude that starts hooks directly', async () => {
  const ask = (version: string) => async (_f: string, args: string[]) => (args[0] === '--version' ? version : process.execPath)
  expect(await hookNodeFor({ claude: CLAUDE }, ask('2.1.330 (Claude Code)'))).toBe(process.execPath)
  forgetHookRunners()
  expect(await hookNodeFor({ claude: CLAUDE }, ask('2.1.0 (Claude Code)'))).toBeNull()
})
