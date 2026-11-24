import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createKiller, endTrees, parseReport } from '../../src/core/proc/safeKill'
import { usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

/**
 * Prints its own child's PID, then idles. Detached, as a shell's children are: a Node child of Node dies with it. Processes
 * that aren't the test's own children end by themselves in 30 s; killing them by PID afterwards could reach another one.
 */
const PARENT = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',detached:true,windowsHide:true});console.log(c.pid);setInterval(()=>{},1000)"

const started: ChildProcess[] = []
afterEach(() => {
  for (const c of started.splice(0)) c.kill()
})

const firstLine = (c: ChildProcess): Promise<number> =>
  new Promise((resolve) => {
    let s = ''
    c.stdout!.on('data', (d) => {
      s += d
      if (s.includes('\n')) resolve(Number(s.trim()))
    })
  })

/** A process that isn't ours by descent: started by a go-between that has exited. */
async function stranger(): Promise<number> {
  const mid = spawn(process.execPath, ['-e', "const c=require('child_process').spawn('ping.exe',['-n','30','127.0.0.1'],{detached:true,stdio:'ignore',windowsHide:true});console.log(c.pid);c.unref();process.exit(0)"], { windowsHide: true })
  const pid = await firstLine(mid)
  return pid
}

test('the helper output is read line by line', () => {
  const listed: Array<[number, number[]]> = []
  const r = parseReport('listed 10 11 12\r\nkilled 10 root\nkilled 11 member\ngone 12 member\nskip 99 not-ours\n', (root, members) => listed.push([root, members]))
  expect(r).toMatchObject({ killed: [10, 11], gone: [12], skipped: [{ pid: 99, why: 'not-ours' }], listed: { 10: [11, 12] } })
  expect(parseReport('kept 10').kept).toEqual([10])
  expect(listed).toEqual([[10, [11, 12]]])
  expect(parseReport('error starter\n').error).toBe('starter')
})

describe.skipIf(process.platform !== 'win32')('on real processes', () => {
  test('a child and what it started are ended; a process that is not ours is left, even when named', async () => {
    const parent = spawn(process.execPath, ['-e', PARENT], { windowsHide: true })
    started.push(parent)
    const grandchild = await firstLine(parent)
    const other = await stranger()
    const report = await endTrees([
      { pid: parent.pid!, bornBefore: Date.now(), tree: true },
      { pid: other, bornBefore: Date.now(), tree: true }
    ])
    expect(report.ok).toBe(true)
    // With them, the console host Windows started for the parent (its child too).
    expect(report.killed).toEqual(expect.arrayContaining([parent.pid!, grandchild]))
    expect(report.skipped).toContainEqual({ pid: other, why: 'not-ours' })
    expect(await waitFor(() => !alive(grandchild))).toBe(true)
    expect(alive(other)).toBe(true)
  })

  test('without tree, only the root is ended', async () => {
    const parent = spawn(process.execPath, ['-e', PARENT], { windowsHide: true })
    started.push(parent)
    const grandchild = await firstLine(parent)
    const report = await endTrees([{ pid: parent.pid!, bornBefore: Date.now() }])
    expect(report.killed).toContain(parent.pid!)
    expect(report.killed).not.toContain(grandchild)
    expect(alive(grandchild)).toBe(true)
  })

  test('a child of ours started after the kill was asked for is a reused PID, and is left', async () => {
    const asked = Date.now() - 1000
    const late = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
    started.push(late)
    const report = await endTrees([{ pid: late.pid!, bornBefore: asked, tree: true }])
    expect(report.killed).toEqual([])
    expect(report.skipped).toContainEqual({ pid: late.pid!, why: 'not-ours' })
    expect(alive(late.pid!)).toBe(true)
  })

  test('requests in the same tick share one helper', async () => {
    const a = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
    const b = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
    started.push(a, b)
    await new Promise((r) => setTimeout(r, 200))
    const [ra, rb] = await Promise.all([endTrees([{ pid: a.pid!, bornBefore: Date.now() }]), endTrees([{ pid: b.pid!, bornBefore: Date.now() }])])
    expect(ra).toBe(rb)
    expect(ra.killed).toEqual(expect.arrayContaining([a.pid!, b.pid!]))
  })

  test('a helper that cannot start kills nothing and says so', async () => {
    const report = await endTrees([{ pid: 4242, bornBefore: Date.now() }], {
      spawn: (() => {
        throw new Error('no powershell')
      }) as never
    })
    expect(report).toMatchObject({ ok: false, killed: [], error: 'no powershell' })
  })

  test('a kept root is proven and held but left running; what it started is ended', async () => {
    const parent = spawn(process.execPath, ['-e', PARENT], { windowsHide: true })
    started.push(parent)
    const grandchild = await firstLine(parent)
    const report = await endTrees([{ pid: parent.pid!, bornBefore: Date.now(), tree: true, keep: true }])
    expect(report.kept).toEqual([parent.pid!])
    expect(report.killed).toContain(grandchild)
    expect(report.killed).not.toContain(parent.pid!)
    expect(parent.exitCode).toBeNull()
  })

  test('a root created before the start window it was given (a session shell spawned later) is not proven', async () => {
    const early = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
    started.push(early)
    await new Promise((r) => setTimeout(r, 300))
    const report = await endTrees([{ pid: early.pid!, bornBefore: Date.now(), bornAfter: Date.now() - 50 }])
    expect(report.skipped).toContainEqual({ pid: early.pid!, why: 'not-ours' })
    expect(early.exitCode).toBeNull()
  })

  test('one helper serves request after request: PowerShell starts and compiles once', async () => {
    const spawned = vi.fn(spawn)
    const killer = createKiller({ spawn: spawned as never })
    try {
      for (let i = 0; i < 3; i++) {
        const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true })
        started.push(c)
        await new Promise((r) => setTimeout(r, 100))
        const report = await killer.run([{ pid: c.pid!, bornBefore: Date.now() }])
        expect(report.killed).toEqual([c.pid!])
      }
      expect(spawned).toHaveBeenCalledTimes(1)
    } finally {
      killer.close()
    }
  })

  test("a helper that can't run is said once, and isn't started again", async () => {
    const onProblem = vi.fn()
    // Exits before it's ready, as PowerShell does when Add-Type is refused.
    const spawned = vi.fn(() => spawn(process.execPath, ['-e', 'console.error("Add-Type refused");process.exit(1)'], { windowsHide: true }))
    const killer = createKiller({ spawn: spawned as never, onProblem })
    const first = await killer.run([{ pid: 4242, bornBefore: Date.now() }])
    const second = await killer.run([{ pid: 4243, bornBefore: Date.now() }])
    expect(first).toMatchObject({ ok: false, error: 'Add-Type refused' })
    expect(second).toMatchObject({ ok: false, error: 'Add-Type refused' })
    expect(onProblem).toHaveBeenCalledTimes(1)
    expect(spawned).toHaveBeenCalledTimes(1)
    expect(killer.problem()).toBe('Add-Type refused')
  })
})
