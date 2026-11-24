import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAfterGate } from '../../src/main/control/after'
import { RpcRefusal, startControlServer, tokenFor, type ControlServer } from '../../src/main/control/server'
import { createVerbs } from '../../src/main/control/verbs'
import { cleanEnv } from '../../src/main/sessions/env'
import { createStatusTracker } from '../../src/main/sessions/statusTracker'
import { claudeNode, fakeHost, fakeRunner, memoryStore } from './fakes'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const CLI_DIR = resolve('resources/cli')
const CLI = join(CLI_DIR, 'patchbay.cjs')
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SECRET = 'cli-test-secret'

let dir: string
let endpointFile: string
let server: ControlServer
let calls: Array<{ caller: string; verb: string; args: Record<string, unknown> }>
let respond: (verb: string, args: Record<string, unknown>) => unknown

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay cli '))
  endpointFile = join(dir, 'endpoint.json')
  calls = []
  respond = () => ({ ok: true })
  server = await startControlServer({
    secret: SECRET,
    endpointFile,
    onHook: () => ({}),
    onRpc: async (caller, verb, args) => {
      calls.push({ caller, verb, args })
      return respond(verb, args)
    }
  })
})

afterEach(async () => {
  await server.close()
  await removeTemp(dir)
})

interface Run {
  code: number
  stdout: string
  stderr: string
}

function env(over: Record<string, string> = {}): Record<string, string> {
  return cleanEnv(process.env, {
    PATCHBAY_NODE_ID: 'node-1',
    PATCHBAY_TOKEN: tokenFor(SECRET, 'node-1'),
    PATCHBAY_ENDPOINT_FILE: endpointFile,
    ...over
  })
}

function run(file: string, args: string[], envOver: Record<string, string> = {}, cwd = dir): Promise<Run> {
  return new Promise((done) => {
    execFile(file, args, { env: env(envOver), cwd, windowsHide: true, timeout: 45_000 }, (e, stdout, stderr) => {
      done({ code: e ? ((e as { code?: number }).code ?? -1) : 0, stdout, stderr })
    })
  })
}

const cli = (args: string[], envOver?: Record<string, string>, cwd?: string) =>
  run(process.execPath, [CLI, ...args], envOver, cwd)

/** The CLI with text piped to it, as from a heredoc. */
function cliPiped(args: string[], input: string): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: env(), cwd: dir, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('a file flag of - reads what is piped in, so a brief or diagram needs no file and no quoting', async () => {
  const brief = "Don't change the parser's tests.\nReport back when done."
  expect((await cliPiped(['open-agent', '--prompt-file', '-', '--title', 'T'], brief)).code).toBe(0)
  expect(calls[0].args).toEqual({ prompt: brief, title: 'T' })
  const diagram = `{"boxes":[{"id":"a","label":"Can't log in"}]}`
  expect((await cliPiped(['draw', '--node', 'b', '--diagram-file', '-'], diagram)).code).toBe(0)
  expect(calls[1].args).toEqual({ node: 'b', diagram })
  expect((await cliPiped(['spawn-team', '--label', 'L', '--members-file', '-'], `[{"name":"a","prompt":"It's small"}]`)).code).toBe(0)
  expect(calls[2].args.members).toEqual([{ name: 'a', prompt: "It's small" }])
})

test('a file flag of - with nothing piped in says so', async () => {
  const r = await cliPiped(['draw', '--node', 'b', '--diagram-file', '-'], '')
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('got nothing on its input')
  expect(calls).toHaveLength(0)
})

test('the CLI passes args with spaces, prints refusals to stderr and exits 1', async () => {
  const text = 'hello "big" world $HOME %PATH% --not-a-flag'
  const ok = await cli(['send', '--node', 'n 2', '--text', text])
  expect(ok).toMatchObject({ code: 0, stderr: '' })
  expect(calls[0]).toEqual({ caller: 'node-1', verb: 'send', args: { node: 'n 2', text } })

  respond = () => {
    throw new RpcRefusal('Node "x" is not yours.')
  }
  const no = await cli(['read', '--node', 'x'])
  expect(no.code).toBe(1)
  expect(no.stderr).toContain('Node "x" is not yours.')
  expect(no.stdout).toBe('')
})

test('a text value may begin with dashes', async () => {
  await cli(['send', '--node', 'n', '--text', '--help'])
  expect(calls[0].args.text).toBe('--help')
})

test('--flag=value works, including a value holding an equals sign', async () => {
  await cli(['send', '--node=n', '--text=a=b'])
  expect(calls[0].args).toEqual({ node: 'n', text: 'a=b' })
})

test('read prints the text as it is; other verbs print JSON', async () => {
  respond = (verb) => (verb === 'read' ? { text: 'line one\nline two\n' } : { id: 'abc' })
  expect((await cli(['read', '--node', 'n', '--tail', '5'])).stdout).toBe('line one\nline two\n')
  expect(calls[0].args).toEqual({ node: 'n', tail: 5 })
  expect(JSON.parse((await cli(['open-terminal'])).stdout)).toEqual({ id: 'abc' })
})

test('--after and --ids take commas or repeats', async () => {
  await cli(['open-agent', '--after', 'a,b', '--after', 'c'])
  expect(calls[0].args.after).toEqual(['a', 'b', 'c'])
  await cli(['arrange', '--ids', 'x,y', '--layout', 'row', '--gap', '12'])
  expect(calls[1].args).toEqual({ ids: ['x', 'y'], layout: 'row', gap: 12 })
})

test('--cwd and --prompt-file are resolved against where the CLI ran', async () => {
  mkdirSync(join(dir, 'sub dir'))
  await cli(['open-agent', '--cwd', 'sub dir', '--prompt-file', 'p.md'], {}, dir)
  expect(calls[0].args).toEqual({ cwd: join(dir, 'sub dir'), promptFile: join(dir, 'p.md') })
})

test('a Git Bash style path is understood', async () => {
  await cli(['open-agent', '--cwd', '/c/Users/someone/repo'])
  expect(calls[0].args.cwd).toBe(resolve('C:/Users/someone/repo'))
})

test('spawn-team takes members inline or from a file, with their paths resolved', async () => {
  const members = [{ name: 'a', promptFile: 'a.md', cwd: 'sub' }, { name: 'b', prompt: 'hi', after: ['a'] }]
  const expected = [
    { name: 'a', promptFile: join(dir, 'a.md'), cwd: join(dir, 'sub') },
    { name: 'b', prompt: 'hi', after: ['a'] }
  ]
  await cli(['spawn-team', '--label', 'My team', '--members', JSON.stringify(members)])
  expect(calls[0].args).toEqual({ label: 'My team', members: expected })

  writeFileSync(join(dir, 'team.json'), JSON.stringify(members))
  await cli(['spawn-team', '--label', 'My team', '--members-file', 'team.json'])
  expect(calls[1].args).toEqual({ label: 'My team', members: expected })
})

test('a Windows path written with single backslashes in team JSON is read as meant, and bad JSON says how to write paths', async () => {
  // As an agent typed it in a real run: a backslash that starts no JSON escape.
  await cli(['spawn-team', '--label', 'T', '--members', '[{"name": "a", "prompt": "Write C:\\Code\\app\\NOTES.md.\\nThen report."}]'])
  expect(calls[0].args.members).toEqual([{ name: 'a', prompt: 'Write C:\\Code\\app\\NOTES.md.\nThen report.' }])
  const bad = await cli(['spawn-team', '--label', 'T', '--members', '[{"name": "a" "prompt": "x"}]'])
  expect(bad.code).toBe(1)
  expect(bad.stderr).toMatch(/forward slashes/)
})

test('team JSON whose \\\\ arrived halved, as Git Bash passes it, still finds the brief and folder it names', async () => {
  // What a real lead's correct JSON became on the way in: \f and \r would otherwise be read as escapes.
  const halved = '[{"name": "farewell", "promptFile": "C:\\Users\\me\\scratchpad\\farewell-brief.md", "cwd": "C:\\Code\\repos\\team"}]'
  await cli(['spawn-team', '--label', 'T', '--members', halved])
  expect(calls[0].args.members).toEqual([{ name: 'farewell', promptFile: 'C:\\Users\\me\\scratchpad\\farewell-brief.md', cwd: 'C:\\Code\\repos\\team' }])
  // Valid JSON is read as it is, newlines in a prompt included.
  await cli(['spawn-team', '--label', 'T', '--members', '[{"name": "a", "prompt": "one\\ntwo", "cwd": "C:/x"}]'])
  expect((calls[1].args.members as Array<{ prompt: string }>)[0].prompt).toBe('one\ntwo')
})

test('text cut short by a quote mark in it says so, and suggests a file', async () => {
  // What the shell makes of '[{"prompt": "Goal: x. Don't touch: y"}]': the apostrophe ends the quoting.
  const r = await cli(['spawn-team', '--label', 'T', '--members', '[{"prompt": "Goal: x. Dont', 'touch: y"}]'])
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/Unexpected "touch: y"}\]".*quote mark inside your text.*--members-file/)
  expect((await cli(['send', 'stray'])).stderr).not.toMatch(/quote mark/)
})

test('an unknown flag, a stray word, a missing value or a bad number never reaches the server', async () => {
  for (const args of [
    ['send', '--nod', 'n'],
    ['send', 'stray'],
    ['send', '--node'],
    ['read', '--node', 'n', '--tail', 'lots'],
    ['spawn-team', '--label', 'x', '--members', '{not json'],
    ['approve']
  ]) {
    const r = await cli(args)
    expect(r.code, args.join(' ')).toBe(1)
    expect(r.stderr).not.toBe('')
  }
  expect(calls).toEqual([])
})

test('an unknown verb lists the verbs; --help needs no session', async () => {
  const bad = await cli(['frobnicate'])
  expect(bad.stderr).toContain('open-agent')
  const help = await cli(['--help'], { PATCHBAY_NODE_ID: '', PATCHBAY_TOKEN: '', PATCHBAY_ENDPOINT_FILE: '' })
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('spawn-team')
})

test('<verb> --help prints that verb\'s usage and needs no session', async () => {
  const none = { PATCHBAY_NODE_ID: '', PATCHBAY_TOKEN: '', PATCHBAY_ENDPOINT_FILE: '' }
  const open = await cli(['open-browser', '--help'], none)
  expect(open.code).toBe(0)
  expect(open.stdout).toContain('open-browser  [--url URL]')
  expect(open.stdout).not.toContain('spawn-team')
  const team = await cli(['spawn-team', '-h'], none)
  expect(team.code).toBe(0)
  expect(team.stdout).toContain('members: [{')
  const browser = await cli(['browser', '--help'], none)
  expect(browser.code).toBe(0)
  expect(browser.stdout).toContain('browser click')
  expect(browser.stdout).toContain('browser screenshot')
  const back = await cli(['browser', 'back', '--help'], none)
  expect(back.stdout).toContain('browser back|forward|reload')
  expect(calls).toHaveLength(0)
})

test('outside a Patchbay session it says so and exits 1', async () => {
  const r = await cli(['list'], { PATCHBAY_NODE_ID: '', PATCHBAY_TOKEN: '', PATCHBAY_ENDPOINT_FILE: '' })
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/Patchbay session/)
})

test('a wrong token is reported and exits 1', async () => {
  const r = await cli(['list'], { PATCHBAY_TOKEN: 'nope' })
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/rejected/)
  expect(calls).toEqual([])
})

test('an app that is not running is reported and exits 1', async () => {
  await server.close()
  const r = await cli(['list'])
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/reach Patchbay/)
})

test('the endpoint file is read on every call, so a restarted app is found', async () => {
  await server.close()
  server = await startControlServer({
    secret: SECRET,
    endpointFile,
    onHook: () => ({}),
    onRpc: async () => ({ second: true })
  })
  expect(JSON.parse((await cli(['list'])).stdout)).toEqual({ second: true })
})

test('a two-member team works from the CLI through the real server and verbs', async () => {
  const store = memoryStore([claudeNode('node-1', { cwd: dir })])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const host = fakeHost()
  const gate = createAfterGate({ store, tracker, runner })
  const verbs = createVerbs({ store, runner, tracker, host, gate })
  await server.close()
  server = await startControlServer({ secret: SECRET, endpointFile, onHook: () => ({}), onRpc: verbs })

  const members = [{ name: 'first', prompt: 'say "hi"' }, { name: 'second', prompt: 'next', after: ['first'] }]
  writeFileSync(join(dir, 'team.json'), JSON.stringify(members))
  const made = await cli(['spawn-team', '--label', 'Two of us', '--members-file', 'team.json'])
  expect(made).toMatchObject({ code: 0, stderr: '' })
  const ids = JSON.parse(made.stdout).members
  expect(runner.started).toEqual([ids.first])

  tracker.apply(ids.first, { type: 'hook', name: 'UserPromptSubmit' })
  tracker.apply(ids.first, { type: 'hook', name: 'Stop' })
  expect(runner.started).toEqual([ids.first, ids.second])

  const transcript = join(dir, 'first.jsonl')
  const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }
  writeFileSync(transcript, `${JSON.stringify(line)}\n`)
  store.dispatch({ op: 'patchNode', id: ids.first, patch: { transcriptPath: transcript } })
  expect((await cli(['read', '--node', ids.first])).stdout).toBe('[assistant]\nhi\n')

  const refused = await cli(['close', '--node', 'node-1'])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain('"node-1"')
})

test('patchbay.cmd passes args with spaces and keeps the exit code', async () => {
  const cmd = join(CLI_DIR, 'patchbay.cmd')
  const ok = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmd, 'send', '--node', 'n', '--text', 'two words'])
  expect(ok).toMatchObject({ code: 0, stderr: '' })
  expect(calls[0].args).toEqual({ node: 'n', text: 'two words' })

  respond = () => {
    throw new RpcRefusal('no')
  }
  const no = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmd, 'list'])
  expect(no.code).toBe(1)
})

test.runIf(existsSync(BASH))('the sh shim keeps /clear intact under Git Bash and works on a login PATH', async () => {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH')!
  const ok = await run(
    BASH,
    ['--login', '-c', 'patchbay send --node n --text "/clear" && patchbay send --node n --text "a b  c"'],
    { [pathKey]: `${CLI_DIR}${delimiter}${process.env[pathKey]}` }
  )
  expect(ok).toMatchObject({ code: 0, stderr: '' })
  expect(calls.map((c) => c.args.text)).toEqual(['/clear', 'a b  c'])
})

test.runIf(existsSync(BASH))("Git Bash's own folders, as /tmp, are read where Git Bash keeps them", async () => {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH')!
  const where = await run(BASH, ['--login', '-c', 'cygpath -w /tmp'])
  const tmp = where.stdout.trim()
  expect(tmp).toMatch(/^[A-Z]:\\/)
  const ok = await run(
    BASH,
    ['--login', '-c', 'patchbay open-agent --prompt-file /tmp/brief.md --cwd /c/Users && patchbay spawn-team --label L --members \'[{"name":"a","promptFile":"/tmp/a.md"}]\''],
    { [pathKey]: `${CLI_DIR}${delimiter}${process.env[pathKey]}` }
  )
  expect(ok).toMatchObject({ code: 0, stderr: '' })
  expect(calls[0].args).toEqual({ promptFile: join(tmp, 'brief.md'), cwd: resolve('C:/Users') })
  expect(calls[1].args.members).toEqual([{ name: 'a', promptFile: join(tmp, 'a.md') }])
})

test('a POSIX path is passed over by cygpath when there is none, and still resolves', async () => {
  // No Git on PATH and no Git where it usually is: the old reading, on the current drive, rather than a failure.
  await cli(['open-agent', '--prompt-file', '/nowhere/brief.md'], { PATH: '', PATCHBAY_CYGPATH: join(dir, 'missing.exe') })
  expect(calls[0].args.promptFile).toBe(resolve('/nowhere/brief.md'))
})

test.runIf(existsSync(BASH))('a checkout keeps the shim in LF, or sh could not run it', () => {
  const attributes = readFileSync(join(CLI_DIR, '.gitattributes'), 'utf8')
  expect(attributes).toMatch(/^patchbay\s+text eol=lf/m)
  expect(readFileSync(join(CLI_DIR, 'patchbay'), 'utf8')).not.toContain('\r')
})

test('guide prints the whole skill, reference files included, for agents that cannot open them', async () => {
  const r = await cli(['guide'])
  expect(r.code).toBe(0)
  expect(r.stdout).not.toMatch(/^---/)
  expect(r.stdout).toContain('# Driving the Patchbay canvas')
  for (const title of ['# Whiteboards on the Patchbay canvas', '# Browser nodes on the Patchbay canvas', '# GitHub issues and pull requests from Patchbay']) expect(r.stdout).toContain(title)
  expect(calls).toEqual([])
})

test('the skill is a plugin whose description and body cover every verb', () => {
  const manifest = JSON.parse(readFileSync('resources/skill/.claude-plugin/plugin.json', 'utf8'))
  expect(manifest.name).toBe('patchbay')
  const main = readFileSync('resources/skill/skills/patchbay/SKILL.md', 'utf8')
  expect(main).toMatch(/^---\r?\nname: patchbay\r?\ndescription: .+\r?\n---\r?\n/)
  // The main file names each reference file, and every verb is in one of them.
  const extra = ['whiteboards.md', 'browser.md', 'github.md']
  for (const f of extra) expect(main).toContain(`(${f})`)
  const skill = [main, ...extra.map((f) => readFileSync(`resources/skill/skills/patchbay/${f}`, 'utf8'))].join('\n')
  for (const verb of ['whoami', 'list', 'open-terminal', 'open-agent', 'spawn-team', 'group', 'arrange', 'rename', 'sticky', 'note', 'link', 'read', 'send', 'wait', 'close', 'whiteboard', 'open-whiteboard', 'draw']) {
    expect(skill).toContain(`patchbay ${verb}`)
  }
})

test('wait --next and team go through; team prints its overview as text', async () => {
  respond = (verb) => (verb === 'team' ? { members: [], text: 'Agents you opened (1):\n- a [1] idle\n' } : { done: true })
  expect((await cli(['wait', '--nodes', 'a,b', '--next', '--timeout', '30'])).code).toBe(0)
  expect(calls[0].args).toEqual({ nodes: ['a', 'b'], next: true, timeout: 30 })
  const team = await cli(['team', '--group', 'g'])
  expect(team).toMatchObject({ code: 0, stdout: 'Agents you opened (1):\n- a [1] idle\n' })
  expect(calls[1]).toMatchObject({ verb: 'team', args: { group: 'g' } })
  expect((await cli(['wait', '--help'])).stdout).toContain('--next: until the first of them')
})

test('open-agent into a group that is gone fails on stderr with exit 1, and creates nothing', async () => {
  const store = memoryStore([claudeNode('node-1', { cwd: dir })])
  const tracker = createStatusTracker({ notify: () => {} })
  const runner = fakeRunner()
  const verbs = createVerbs({ store, runner, tracker, host: fakeHost(), gate: createAfterGate({ store, tracker, runner }) })
  await server.close()
  server = await startControlServer({ secret: SECRET, endpointFile, onHook: () => ({}), onRpc: verbs })
  const made = JSON.parse((await cli(['spawn-team', '--label', 'Pair', '--members', '[{"name":"only"}]'])).stdout)
  expect((await cli(['close', '--node', made.members.only])).code).toBe(0)
  const before = store.get().nodes.length
  const r = await cli(['open-agent', '--group', made.group, '--prompt', 'review'])
  expect(r.code).toBe(1)
  expect(r.stdout).toBe('')
  expect(r.stderr).toContain(`Group "${made.group}" is gone: it was removed when its last member, "only", closed. Nothing was created.`)
  expect(store.get().nodes.length).toBe(before)
})
