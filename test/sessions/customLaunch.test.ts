import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildClaudeLaunch, customLaunch, splitCommand } from '../../src/main/sessions/claudeLaunch'
import { createSessionHost } from '../../src/main/sessions/host'
import type { ClaudeNode } from '../../src/shared/model'

const programs: Record<string, string> = {
  bash: 'C:\\Git\\bin\\bash.exe',
  powershell: 'C:\\ps\\powershell.exe',
  pwsh: 'C:\\ps\\pwsh.exe',
  cmd: 'C:\\Windows\\cmd.exe',
  claude: 'C:\\bin\\claude.exe',
  wrap: 'C:\\bin\\wrap.cmd',
  'script.ps1': 'C:\\bin\\script.ps1'
}
const find = (name: string): string | null => programs[name] ?? null

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay custom '))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('splits on spaces outside double quotes and keeps backslashes', () => {
  expect(splitCommand('"C:\\Program Files\\x.exe" --a b')).toEqual(['C:\\Program Files\\x.exe', '--a', 'b'])
})

test('with a command only, runs that program directly and adds the options last', () => {
  expect(customLaunch({ command: 'claude --model x' }, ['--a'], find)).toEqual({ file: 'C:\\bin\\claude.exe', args: ['--model', 'x', '--a'] })
})

test('{args} puts the options where it says', () => {
  expect(customLaunch({ command: 'claude {args} --verbose' }, ['--a'], find).args).toEqual(['--a', '--verbose'])
})

test('a batch wrapper goes through cmd.exe', () => {
  const run = customLaunch({ command: 'wrap' }, ['--a'], find)
  expect(run.file.toLowerCase()).toContain('cmd')
  expect(run.args.at(-1)).toContain('wrap.cmd')
})

test('a shell operator with no terminal is refused rather than passed to Claude', () => {
  expect(() => customLaunch({ command: 'setup && claude' }, [], find)).toThrow(/needs a shell/)
  expect(() => customLaunch({ command: 'A=1 claude' }, [], find)).toThrow(/needs a shell/)
})

test('a script Windows cannot start by itself says which setting to change', () => {
  expect(() => customLaunch({ command: 'script.ps1' }, [], find)).toThrow(/terminal program/)
})

test('a missing program names itself', () => {
  expect(() => customLaunch({ command: 'nope' }, [], find)).toThrow(/"nope" was not found/)
  expect(() => customLaunch({ terminal: 'nope' }, [], find)).toThrow(/"nope" was not found/)
})

test('a terminal has to be a .exe file', () => {
  expect(() => customLaunch({ terminal: 'wrap' }, [], find)).toThrow(/\.exe/)
})

test('bash loads the profile and quotes each option once', () => {
  const run = customLaunch({ terminal: 'bash', command: 'source a.sh && claude' }, ['--x', "it's $HOME"], find)
  expect(run.args.slice(0, 3)).toEqual(['--login', '-i', '-c'])
  expect(run.args[3]).toBe(`source a.sh && claude '--x' 'it'\\''s $HOME'`)
})

test('PowerShell doubles curly quotes, which also end its strings', () => {
  expect(customLaunch({ terminal: 'pwsh' }, ['a’; evil'], find).args.at(-1)).toBe("claude 'a’’; evil'")
})

test('only Windows PowerShell escapes double quotes for the program', () => {
  expect(customLaunch({ terminal: 'powershell' }, ['a"b'], find).args.at(-1)).toBe(`claude 'a\\"b'`)
  expect(customLaunch({ terminal: 'pwsh' }, ['a"b'], find).args.at(-1)).toBe(`claude 'a"b'`)
})

test('PowerShell calls a quoted path instead of printing it', () => {
  expect(customLaunch({ terminal: 'pwsh', command: '"C:\\a b\\claude.exe"' }, ['x'], find).args.at(-1)).toBe(`& "C:\\a b\\claude.exe" 'x'`)
})

test('cmd escapes once for a program, and twice for a batch file or anything unknown', () => {
  const line = (command: string): string => customLaunch({ terminal: 'cmd', command }, ['a&b'], find).args.at(-1)!
  expect(line('claude')).toContain('^"a^&b^"')
  expect(line('wrap')).toContain('^^^"a^^^&b^^^"')
  expect(line('unknown')).toContain('^^^"a^^^&b^^^"')
  expect(line('wrap && claude')).toContain('^"a^&b^"')
})

test('a terminal path with spaces works without quotes when it is a real file', () => {
  const exe = join(dir, 'my bash.exe')
  writeFileSync(exe, '')
  expect(customLaunch({ terminal: exe }, ['x'], (n) => (n === exe ? exe : null)).file).toBe(exe)
})

test('buildClaudeLaunch uses the setting and still passes the session options', () => {
  const node: ClaudeNode = { id: 'n1', kind: 'claude', title: 'C', x: 0, y: 0, width: 600, height: 400, parentId: null, cwd: dir, sessionId: null, transcriptPath: null, after: [] }
  const launch = buildClaudeLaunch(node, {
    sessionDir: join(dir, 'sessions'),
    hookScript: 'h.cjs',
    pluginDir: 'p',
    cliDir: 'c',
    endpointFile: 'e',
    token: 't',
    baseEnv: { Path: 'C:\\Windows' },
    claudeCommand: `"${process.execPath}" {args}`
  })
  expect(launch.file).toBe(process.execPath)
  expect(launch.args).toContain('--session-id')
  expect(launch.args).toContain('--settings')
})

// Real shells, with a program that records exactly the arguments it received. A prompt full of shell
// syntax has to arrive as one unchanged argument, and the file named in it must never be created.
const canary = (): string => join(dir, 'pwned.txt')
const nasty = (): string[] => [
  '--settings',
  'C:\\Users\\me x\\a.json',
  '--',
  `it's "quoted" $HOME %PATH% & echo x > "${canary()}" ; echo y > "${canary()}" | $(echo z > "${canary()}") \`echo w\` ’ ^ (a) !b! \\`
]

function runThrough(terminal: string, wrapper?: string): Promise<string[]> {
  const out = join(dir, 'args.json')
  rmSync(out, { force: true })
  const script = join(dir, 'record.js')
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`)
  const node = process.execPath.replace(/\\/g, '/')
  const command = wrapper ?? `"${node}" "${script.replace(/\\/g, '/')}"`
  const run = customLaunch({ terminal, command }, nasty())
  const host = createSessionHost()
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 30000)
    host.onExit(() => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(readFileSync(out, 'utf8')))
      } catch (e) {
        reject(e)
      }
    })
    host.start({ nodeId: 'x', file: run.file, args: run.args, cwd: dir, env })
  })
}

const available = (name: string): boolean => spawnSync('where.exe', [name], { stdio: 'ignore' }).status === 0
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'

test('Git Bash delivers a hostile prompt unchanged', async () => {
  expect(await runThrough(gitBash)).toEqual(nasty())
  expect(() => readFileSync(canary())).toThrow()
}, 40000)

test('Windows PowerShell delivers a hostile prompt unchanged', async () => {
  expect(await runThrough('powershell.exe')).toEqual(nasty())
  expect(() => readFileSync(canary())).toThrow()
}, 40000)

test.runIf(available('pwsh'))('PowerShell 7 delivers a hostile prompt unchanged', async () => {
  expect(await runThrough('pwsh.exe')).toEqual(nasty())
  expect(() => readFileSync(canary())).toThrow()
}, 40000)

test('cmd delivers shell syntax to a program without running it', async () => {
  const got = await runThrough('cmd.exe')
  expect(got.slice(0, 3)).toEqual(nasty().slice(0, 3))
  expect(() => readFileSync(canary())).toThrow()
}, 40000)
