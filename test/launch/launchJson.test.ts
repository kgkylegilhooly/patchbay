import { describe, expect, test } from 'vitest'
import { describePlan, parseJsonc, readLaunchItems, substitute, type LaunchConfigItem, type LaunchContext } from '../../src/core/launch/launchJson'

const ctx: LaunchContext = { folder: 'C:\\work\\app', env: { PORT: '3000' }, home: 'C:\\Users\\me' }
const read = (json: unknown) => {
  const r = readLaunchItems(typeof json === 'string' ? json : JSON.stringify(json), ctx)
  if (!r.ok) throw new Error(r.reason)
  return r.items
}
const one = (config: Record<string, unknown>) => read({ configurations: [{ type: 'node', request: 'launch', name: 'App', ...config }] })[0] as LaunchConfigItem

describe('parseJsonc', () => {
  test('takes comments and trailing commas, as VS Code writes them', () => {
    const text = `\uFEFF{
      // A line comment
      "version": "0.2.0", /* a block
      comment */
      "configurations": [
        { "name": "a // not a comment", "x": "/* nor this */", },
      ],
    }`
    expect(parseJsonc(text)).toEqual({ version: '0.2.0', configurations: [{ name: 'a // not a comment', x: '/* nor this */' }] })
  })

  test('leaves commas and escaped quotes inside strings alone', () => {
    expect(parseJsonc('{"a": "x, ]", "b": "say \\"hi\\", }"}')).toEqual({ a: 'x, ]', b: 'say "hi", }' })
  })

  test('refuses what is still not JSON', () => {
    expect(() => parseJsonc('{ "a": 1 /* open')).toThrow(/never closed/)
    expect(() => parseJsonc('{ a: 1 }')).toThrow()
  })

  test('a bad file gives a reason, not an exception', () => {
    expect(readLaunchItems('{', ctx)).toMatchObject({ ok: false, reason: /isn't valid JSON/ })
    expect(readLaunchItems('[]', ctx)).toMatchObject({ ok: false })
  })
})

describe('substitute', () => {
  test('fills in the folder and the variables that mean the same outside an editor', () => {
    expect(substitute('${workspaceFolder}\\a.js', ctx)).toBe('C:\\work\\app\\a.js')
    expect(substitute('${workspaceRoot}|${cwd}|${workspaceFolderBasename}', ctx)).toBe('C:\\work\\app|C:\\work\\app|app')
    expect(substitute('${userHome}', ctx)).toBe('C:\\Users\\me')
    expect(substitute('port=${env:PORT} none=${env:NOPE}', ctx)).toBe('port=3000 none=')
    expect(substitute('a${/}b${pathSeparator}c', ctx)).toMatch(/^a[\\/]b[\\/]c$/)
  })

  test.each([
    ['${file}', /open in an editor/],
    ['${relativeFile}', /editor/],
    ['${input:pick}', /prompt for/],
    ['${command:pickProcess}', /VS Code command/],
    ['${config:x.y}', /setting/],
    ['${workspaceFolder:other}', /another workspace folder/],
    ['${mystery}', /doesn't know/]
  ])('refuses %s', (text, why) => {
    expect(() => substitute(text, ctx)).toThrow(why)
  })
})

describe('configurations', () => {
  test('a node program with arguments, folder and environment', () => {
    const item = one({ program: '${workspaceFolder}/server.js', args: ['--port', '${env:PORT}'], cwd: '${workspaceFolder}/sub', env: { MODE: 'dev', DROP: null } })
    expect(item.problem).toBeUndefined()
    expect(item.plan).toEqual({ file: 'node', args: ['C:\\work\\app/server.js', '--port', '3000'], cwd: 'C:\\work\\app/sub', env: { MODE: 'dev', DROP: null } })
  })

  test('a runtimeExecutable with runtimeArgs, as with npm run dev', () => {
    const item = one({ runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'] })
    expect(item.plan).toMatchObject({ file: 'npm', args: ['run', 'dev'], cwd: 'C:\\work\\app' })
  })

  test('runtimeArgs go before the program, and args after it', () => {
    expect(one({ program: 'a.js', runtimeArgs: ['--inspect=0'], args: ['x'] }).plan?.args).toEqual(['--inspect=0', 'a.js', 'x'])
  })

  test('a relative cwd is taken from the folder', () => {
    expect(one({ program: 'a.js', cwd: 'packages/web' }).plan?.cwd).toMatch(/^C:\\work\\app[\\/]packages[\\/]web$/)
  })

  test('the windows section applies, with its env merged in', () => {
    const item = one({ program: 'a.js', env: { A: '1', B: '1' }, windows: { program: 'win.js', env: { B: '2' } } })
    expect(item.plan).toMatchObject({ args: ['win.js'], env: { A: '1', B: '2' } })
  })

  test('debugger-only fields are left out and listed', () => {
    const item = one({ program: 'a.js', skipFiles: ['<node_internals>/**'], console: 'integratedTerminal' })
    expect(item.plan).toBeDefined()
    expect(item.notes).toEqual(['skipFiles', 'console'])
  })

  test('pwa-node is the same as node', () => {
    expect(one({ type: 'pwa-node', program: 'a.js' }).plan).toBeDefined()
  })

  test.each([
    [{ type: 'python', program: 'a.py' }, /"python".*Only node/],
    [{ request: 'attach', port: 9229 }, /attaches a debugger/],
    [{ program: 'a.js', preLaunchTask: 'build' }, /preLaunchTask.*doesn't run VS Code tasks/],
    [{ program: 'a.js', postDebugTask: 'x' }, /postDebugTask/],
    [{ program: 'a.js', envFile: '.env' }, /envFile/],
    [{ program: 'a.js', runtimeVersion: '18' }, /runtimeVersion/],
    [{ program: 'a.js', serverReadyAction: {} }, /serverReadyAction/],
    [{ program: 'a.js', somethingNew: 1 }, /"somethingNew".*can't honor/],
    [{}, /no program or runtimeExecutable/],
    [{ program: 'a.js', args: '--a --b' }, /one string.*list/],
    [{ program: 'a.js', args: [1] }, /list of strings/],
    [{ program: 'a.js', env: { A: 1 } }, /string or null/],
    [{ program: '${file}' }, /editor/]
  ])('can not run %j', (config, why) => {
    const item = one(config)
    expect(item.plan).toBeUndefined()
    expect(item.problem).toMatch(why)
  })

  test('two configurations with one name are not guessed between', () => {
    const items = read({ configurations: [{ type: 'node', request: 'launch', name: 'A', program: 'a.js' }, { type: 'node', request: 'launch', name: 'A', program: 'b.js' }] })
    expect((items[1] as LaunchConfigItem).problem).toMatch(/same name/)
  })

  test('describePlan shows the command line, quoting where needed', () => {
    expect(describePlan({ file: 'node', args: ['my app.js', '--x'], cwd: '', env: {} })).toBe('node "my app.js" --x')
  })
})

describe('compounds', () => {
  const configs = [
    { type: 'node', request: 'launch', name: 'Server', program: 's.js' },
    { type: 'node', request: 'launch', name: 'Client', program: 'c.js' },
    { type: 'chrome', request: 'launch', name: 'Browser' }
  ]

  test('lists its members, all runnable', () => {
    const items = read({ configurations: configs, compounds: [{ name: 'Both', configurations: ['Server', 'Client'], stopAll: true }] })
    expect(items[3]).toEqual({ kind: 'compound', name: 'Both', members: ['Server', 'Client'], notes: ['stopAll: each one has its own Stop here'] })
  })

  test.each([
    [{ name: 'X', configurations: ['Server', 'Browser'] }, /"Browser" can't run here/],
    [{ name: 'X', configurations: ['Server', 'Nope'] }, /"Nope", which isn't/],
    [{ name: 'X', configurations: [] }, /no configurations/],
    [{ name: 'X', configurations: [{ name: 'Server', folder: 'web' }] }, /another workspace folder/],
    [{ name: 'X', configurations: ['Server'], preLaunchTask: 'build' }, /preLaunchTask/]
  ])('can not run %j', (compound, why) => {
    const items = read({ configurations: configs, compounds: [compound] })
    expect(items[3]).toMatchObject({ kind: 'compound', problem: why })
  })
})
