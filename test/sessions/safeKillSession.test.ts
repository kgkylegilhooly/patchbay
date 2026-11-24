import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { endTrees } from '../../src/core/proc/safeKill'
import { createSessionHost } from '../../src/main/sessions/host'
import type { SessionHost } from '../../src/shared/contract'
import { removeTemp, usesRealProcesses } from '../support/realProcess'

usesRealProcesses()

// Round 4 left one gap (docs/plans/r4-leftovers.md, review M1): Stop listed a session's console, then a taskkill per PID
// opened each 50-500 ms later, and a listed process that ended in between could have handed its PID to another one.
// Here the gap is made as wide as needed (the helper waits after reading the console), the listed processes end, and
// processes are started until Windows gives one of them a listed PID. A kill by PID would end it; this one mustn't.
// See docs/plans/r5-jobkill.md.

const CMD = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
const PAUSE_MS = 30_000
const MEMBERS = 10

/** A process on the session's console that says it's up, then ends once the flag file appears, saying so. */
const MEMBER = `const fs = require('fs')
console.log('member-up')
setInterval(() => {
  if (fs.existsSync(process.argv[2])) {
    console.log('member-bye')
    process.exit(0)
  }
}, 50)
`

const hosts: SessionHost[] = []
const churn: ChildProcess[] = []
let dir: string | undefined
afterEach(async () => {
  for (const c of churn.splice(0)) c.kill()
  await Promise.all(hosts.splice(0).map((h) => h.kill('n')))
  await removeTemp(dir)
  dir = undefined
})

const count = (text: string, word: string): number => text.split(word).length - 1

const exited = (c: ChildProcess): Promise<void> => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())))

test.skipIf(process.platform !== 'win32')('a console member that ends after the list and whose PID goes to another process is never killed', async () => {
  const h = createSessionHost()
  hosts.push(h)
  h.start({ nodeId: 'n', file: CMD, args: ['/k', 'echo ready'], cwd: tmpdir(), env: process.env as Record<string, string> })
  await vi.waitFor(() => expect(h.snapshot('n').data).toContain('ready'), { timeout: 30_000 })
  const shell = h.pid('n')!
  // Processes on the session's console, as a run's npm children would be.
  dir = mkdtempSync(join(tmpdir(), 'patchbay safekill '))
  const script = join(dir, 'member.cjs')
  const flag = join(dir, 'flag')
  writeFileSync(script, MEMBER)
  h.write('n', `for /L %i in (1,1,${MEMBERS}) do @start /b "" "${process.execPath}" "${script}" "${flag}"\r`)
  await vi.waitFor(() => expect(count(h.snapshot('n').data, 'member-up')).toBe(MEMBERS), { timeout: 60_000 })

  let listedAt = 0
  let listed: number[] = []
  const ending = endTrees([{ pid: shell, bornBefore: Date.now(), console: true, tree: true }], {
    pauseAfterListMs: PAUSE_MS,
    limitMs: PAUSE_MS + 30_000,
    onListed: (_root, members) => {
      listed = members
      listedAt = Date.now()
    }
  })
  await vi.waitFor(() => expect(listedAt).toBeGreaterThan(0), { timeout: 20_000 })
  const freed = new Set(listed.filter((pid) => pid !== shell))
  expect(freed.size).toBe(MEMBERS)

  // The listed processes end. Then processes are started, and the rest ended, until one has a listed PID.
  writeFileSync(flag, '')
  await vi.waitFor(() => expect(count(h.snapshot('n').data, 'member-bye')).toBe(MEMBERS), { timeout: 15_000 })
  await new Promise((r) => setTimeout(r, 300))
  let reused: ChildProcess | null = null
  let tries = 0
  const deadline = listedAt + PAUSE_MS - 2000
  while (!reused && Date.now() < deadline) {
    const c = spawn('ping.exe', ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
    churn.push(c)
    tries++
    if (c.pid && freed.has(c.pid)) reused = c
    else {
      c.kill()
      await exited(c)
    }
  }
  expect(reused, `no listed PID was reused in ${tries} process starts`).not.toBeNull()
  const report = await ending
  expect(report.ok).toBe(true)
  // A kill by PID from the list, as taskkill /pid did, would have reached it.
  expect(listed).toContain(reused!.pid)
  expect(report.killed).not.toContain(reused!.pid)
  expect(report.skipped).toContainEqual({ pid: reused!.pid, why: 'not-listed' })
  expect(reused!.exitCode).toBeNull()
  expect(reused!.signalCode).toBeNull()
  // The session itself was still ended.
  expect(report.killed).toContain(shell)
  await vi.waitFor(() => expect(h.isRunning('n')).toBe(false), { timeout: 10_000 })
}, 180_000)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * In the session: a Node on its console that starts a ping with no console at all, so only the tree reaches it. The ping
 * ends by itself in 30 s: a test killing it by PID afterwards could reach another process, the very thing ruled out here.
 */
const OFF_CONSOLE = `"${process.execPath}" -e "const c=require('child_process').spawn('ping.exe',['-n','30','127.0.0.1'],{detached:true,stdio:'ignore',windowsHide:true});console.log('off-'+c.pid+'-console');setInterval(()=>{},1000)"`

async function sessionWithOffConsoleChild(): Promise<{ h: SessionHost; offConsole: number }> {
  const h = createSessionHost()
  hosts.push(h)
  h.start({ nodeId: 'n', file: CMD, args: [], cwd: tmpdir(), env: process.env as Record<string, string> })
  h.write('n', `${OFF_CONSOLE}\r`)
  let offConsole = 0
  await vi.waitFor(
    () => {
      const m = /off-(\d+)-console/.exec(h.snapshot('n').data)
      expect(m).not.toBeNull()
      offConsole = Number(m![1])
    },
    { timeout: 30_000 }
  )
  return { h, offConsole }
}

test.skipIf(process.platform !== 'win32')("Stop on a run (tree) ends what the session started off its console; closing a window doesn't", async () => {
  const tree = await sessionWithOffConsoleChild()
  await tree.h.kill('n', { tree: true })
  expect(tree.h.isRunning('n')).toBe(false)
  await vi.waitFor(() => expect(alive(tree.offConsole)).toBe(false), { timeout: 10_000 })

  const plain = await sessionWithOffConsoleChild()
  await plain.h.kill('n')
  expect(plain.h.isRunning('n')).toBe(false)
  expect(alive(plain.offConsole)).toBe(true)
}, 120_000)
