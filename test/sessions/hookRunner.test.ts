import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { claudeRunsExecHooks, EXEC_HOOKS_SINCE, forgetHookRunners, hookNode, hookNodeFor, parseClaudeVersion, runsExecHooks, type Ask } from '../../src/main/sessions/hookRunner'

const onWindows = process.platform === 'win32'

let dir: string
beforeEach(() => {
  forgetHookRunners()
  dir = mkdtempSync(join(tmpdir(), 'pb-hooknode-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const CLAUDE = { file: 'C:\\bin\\claude.exe', prefixArgs: [] }

/** A file standing in for a node.exe at this path under the test folder. */
function exe(...parts: string[]): string {
  const file = join(dir, ...parts)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '')
  return file
}

/** Answers where.exe with these lines, and `<node> -p process.execPath` from the map. */
function asker(where: string[], execPaths: Record<string, string> = {}): Ask & ReturnType<typeof vi.fn> {
  return vi.fn(async (file: string, args: string[]) => {
    if (file === 'where.exe') return `${where.join('\r\n')}\r\n`
    if (args[0] === '--version') return '2.1.330 (Claude Code)\n'
    if (args[1] === 'process.execPath' && execPaths[file]) return `${execPaths[file]}\n`
    throw new Error(`unexpected: ${file} ${args.join(' ')}`)
  })
}

test('reads the version Claude Code prints', () => {
  expect(parseClaudeVersion('2.1.330 (Claude Code)\n')).toEqual([2, 1, 330])
  expect(parseClaudeVersion('not a version')).toBeNull()
})

test('starts hooks directly from Claude Code 2.1.139, whose changelog added exec form', () => {
  expect(EXEC_HOOKS_SINCE).toEqual([2, 1, 139])
  expect(runsExecHooks([2, 1, 138])).toBe(false)
  expect(runsExecHooks([2, 1, 139])).toBe(true)
  expect(runsExecHooks([2, 1, 330])).toBe(true)
  expect(runsExecHooks([2, 2, 0])).toBe(true)
  expect(runsExecHooks([3, 0, 0])).toBe(true)
  expect(runsExecHooks([2, 0, 999])).toBe(false)
  expect(runsExecHooks([1, 9, 999])).toBe(false)
  expect(runsExecHooks(null)).toBe(false)
})

test('asks the claude program its version once per app run, however many nodes start with it', async () => {
  const ask = vi.fn(async () => '2.1.330 (Claude Code)')
  const answers = await Promise.all([1, 2, 3].map(() => claudeRunsExecHooks({ claude: CLAUDE }, ask)))
  expect(answers).toEqual([true, true, true])
  expect(ask).toHaveBeenCalledTimes(1)
  expect(ask).toHaveBeenCalledWith('C:\\bin\\claude.exe', ['--version'])
})

test('anything unclear keeps the command line: an old Claude, or no answer', async () => {
  expect(await claudeRunsExecHooks({ claude: CLAUDE }, async () => '2.1.100 (Claude Code)')).toBe(false)
  forgetHookRunners()
  expect(await claudeRunsExecHooks({ claude: CLAUDE }, async () => Promise.reject(new Error('ENOENT')))).toBe(false)
  expect(await claudeRunsExecHooks({}, async () => '2.1.330')).toBe(false)
})

test('a custom Claude command, or Claude inside another terminal program, is never run just to ask its version', async () => {
  // A wrapper can do more than print a version, npx can download, and ssh or wsl reach another machine.
  const ask = vi.fn(async () => '2.1.330 (Claude Code)')
  for (const launch of [{ claudeCommand: 'npx -y @anthropic-ai/claude-code' }, { claudeCommand: 'ssh devbox claude' }, { claudeTerminal: 'wsl.exe' }, { claude: CLAUDE, claudeTerminal: 'wsl.exe' }]) {
    expect(await claudeRunsExecHooks(launch, ask)).toBe(false)
  }
  expect(ask).not.toHaveBeenCalled()
})

test.runIf(onWindows)('Node is the node.exe the PATH gives, shim or not, asked once, and nothing is run to find it', async () => {
  // Volta's shim outlives uninstalling a version and follows the person's choice, as the PATH lookup did.
  const shim = exe('Volta', 'bin', 'node.exe')
  const ask = asker([shim, exe('nodejs', 'node.exe')])
  expect(await hookNode(ask)).toBe(shim)
  expect(await hookNode(ask)).toBe(shim)
  expect(ask).toHaveBeenCalledTimes(1)
  expect(ask).toHaveBeenCalledWith('where.exe', ['node'])
})

test.runIf(onWindows)("fnm's folder for one shell, which fnm removes later, is looked through to the installed Node", async () => {
  const shellFolder = exe('fnm_multishells', '1234_5678', 'node.exe')
  const installed = exe('fnm', 'node-versions', 'v22.19.0', 'installation', 'node.exe')
  expect(await hookNode(asker([shellFolder], { [shellFolder]: installed }))).toBe(installed)
  forgetHookRunners()
  // If that leads nowhere lasting, the command line stays.
  expect(await hookNode(asker([shellFolder], { [shellFolder]: shellFolder }))).toBeNull()
})

test.runIf(onWindows)('a first `node` that is a .cmd, or none at all, keeps the command line', async () => {
  expect(await hookNode(asker([exe('npm', 'node.cmd'), exe('nodejs', 'node.exe')]))).toBeNull()
  forgetHookRunners()
  expect(await hookNode(async () => Promise.reject(new Error('INFO: Could not find files')))).toBeNull()
})

test.runIf(onWindows)('a Node that has gone is looked for again at the next launch', async () => {
  const node = exe('nodejs', 'node.exe')
  const ask = asker([node])
  expect(await hookNode(ask)).toBe(node)
  rmSync(node)
  expect(await hookNode(ask)).toBeNull()
  expect(ask).toHaveBeenCalledTimes(2)
})

test.runIf(onWindows)('hookNodeFor asks both at once and gives a Node only for a Claude that starts hooks directly', async () => {
  const node = exe('nodejs', 'node.exe')
  const started: string[] = []
  const gate: { open?: () => void } = {}
  const opened = new Promise<void>((r) => (gate.open = r))
  const ask: Ask = async (file, args) => {
    started.push(file)
    // The version answer waits until where.exe has been asked too: one after the other would never finish.
    if (args[0] === '--version') {
      await opened
      return '2.1.330 (Claude Code)'
    }
    gate.open?.()
    return node
  }
  expect(await hookNodeFor({ claude: CLAUDE }, ask)).toBe(node)
  expect(started.sort()).toEqual(['C:\\bin\\claude.exe', 'where.exe'])
  forgetHookRunners()
  expect(await hookNodeFor({ claude: CLAUDE }, async (f, a) => (a[0] === '--version' ? '2.1.0' : node))).toBeNull()
})
