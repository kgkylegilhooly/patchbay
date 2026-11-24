import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { exitGuard } from '../../src/main/sessions/hostSpawn'
import { usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

// The app's exit guard ended the app by PID 4 s after a quit, when the app might long have gone and its PID been given
// to another process. On Windows it now has safeKill's helper end its parent only if the process with that PID was
// created before the guard (docs/plans/r5-jobkill.md).

const started: ChildProcess[] = []
afterEach(() => {
  for (const c of started.splice(0)) c.kill()
})

const exited = (c: ChildProcess, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    c.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

/** A stand-in for the app: starts the guard as the app does, naming `target` (itself unless given), then stays. */
function stuckApp(target?: number, opts: { noHelper?: boolean } = {}): ChildProcess {
  const { script, env } = exitGuard(0, 300)
  const named = target === undefined ? 'process.pid' : String(target)
  const code =
    `const env={...process.env,...JSON.parse(process.env.G_ENV)};` +
    `if(env.PB_EXIT_GUARD){const k=JSON.parse(env.PB_EXIT_GUARD);k.pid=${named};k.request='0 '+${named}+':0:p';${opts.noHelper ? "k.file='C:/no/such/powershell.exe';" : ''}env.PB_EXIT_GUARD=JSON.stringify(k)}` +
    `require('child_process').spawn(process.execPath,['-e',process.env.G_SCRIPT],{detached:true,stdio:'ignore',windowsHide:true,env}).unref();` +
    `setInterval(()=>{},1000)`
  const app = spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: 'ignore', env: { ...process.env, G_SCRIPT: script, G_ENV: JSON.stringify(env) } })
  started.push(app)
  return app
}

test('elsewhere the guard ends its parent by PID, as before', () => {
  expect(exitGuard(1234, 4000, 'linux')).toEqual({ script: 'const pid=1234;setTimeout(()=>{try{process.kill(pid)}catch{}process.exit(0)},4000)', env: {} })
})

describe.skipIf(process.platform !== 'win32')('on Windows', () => {
  test('an app still there when the guard fires is ended', async () => {
    const app = stuckApp()
    expect(await exited(app, 30_000)).toBe(true)
  })

  test("a guard whose helper can't run falls back to the old kill, as round 4 did", async () => {
    const app = stuckApp(undefined, { noHelper: true })
    expect(await exited(app, 30_000)).toBe(true)
  })

  test('a process that is not the guard\'s parent is never ended, even with its PID named', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' })
    started.push(other)
    const app = stuckApp(other.pid!)
    // Long enough for the guard and its helper to have run (as the other test shows, ending a stuck app).
    expect(await exited(other, 8000)).toBe(false)
    expect(app.exitCode).toBeNull()
  })
})
