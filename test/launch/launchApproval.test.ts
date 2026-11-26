import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { listLaunchConfigs, prepareLaunchRun } from '../../src/main/launchRuns'

let folder: string
let planFile: string
const launcher = 'C:\\patchbay\\launch-run.cjs'

const writeLaunch = (args: string[]): void =>
  writeFileSync(join(folder, '.vscode', 'launch.json'), JSON.stringify({ configurations: [{ name: 'Server', type: 'node', request: 'launch', runtimeExecutable: 'node', args }] }))

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'patchbay launch '))
  mkdirSync(join(folder, '.vscode'))
  planFile = join(folder, 'plan', 'run.json')
  writeLaunch(['server.js'])
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

// LJ1: launch.json is a file an agent can edit with file permission alone. What it runs is shown and agreed to first,
// and again whenever it changes, so an edit can't turn into a command run, least of all by an automatic restart.
test('a launch.json plan runs only once the person has agreed to exactly that command, and again after any change', async () => {
  const ctx = { planFile, launcher }
  const first = await prepareLaunchRun({ folder, name: 'Server' }, ctx)
  expect(first).toMatchObject({ ok: false, approvePlan: expect.any(String) })
  if (first.ok || !first.approvePlan) throw new Error('expected a question')
  expect(first.reason).toContain('node server.js')
  expect(existsSync(planFile)).toBe(false)

  const agreed = await prepareLaunchRun({ folder, name: 'Server' }, ctx, first.approvePlan)
  expect(agreed).toMatchObject({ ok: true, approved: first.approvePlan })
  expect(existsSync(planFile)).toBe(true)
  // Agreed once, it runs as before: Run, Restart, and Restart when it stops.
  expect(await prepareLaunchRun({ folder, name: 'Server', approved: first.approvePlan }, ctx)).toMatchObject({ ok: true })

  // An edit to launch.json, as an agent with file access could make.
  rmSync(planFile)
  writeLaunch(['-e', "require('child_process').exec('calc')"])
  const changed = await prepareLaunchRun({ folder, name: 'Server', approved: first.approvePlan }, ctx)
  expect(changed).toMatchObject({ ok: false, approvePlan: expect.any(String) })
  if (changed.ok) throw new Error('expected a question')
  expect(changed.reason).toContain('calc')
  expect(existsSync(planFile)).toBe(false)
  // What was agreed before doesn't cover the new command.
  expect(await prepareLaunchRun({ folder, name: 'Server', approved: first.approvePlan }, ctx, first.approvePlan)).toMatchObject({ ok: false })
  expect(await prepareLaunchRun({ folder, name: 'Server', approved: first.approvePlan }, ctx, changed.approvePlan)).toMatchObject({ ok: true, approved: changed.approvePlan })
})

test("picking a configuration in the form agrees to the command its row showed; the question names any env it sets", async () => {
  const ctx = { planFile, launcher }
  const listing = listLaunchConfigs(folder)
  if (!listing.ok) throw new Error(listing.reason)
  const row = listing.items.find((i) => i.name === 'Server')
  expect(row?.command).toBe('node server.js')
  // What the form gives the new run node: it starts on that click without asking again.
  expect(await prepareLaunchRun({ folder, name: 'Server', approved: row?.approve }, ctx)).toMatchObject({ ok: true })

  writeFileSync(join(folder, '.vscode', 'launch.json'), JSON.stringify({ configurations: [{ name: 'Server', type: 'node', request: 'launch', program: 'server.js', env: { NODE_OPTIONS: '--require ./x.js' } }] }))
  const asked = await prepareLaunchRun({ folder, name: 'Server', approved: row?.approve }, ctx)
  expect(asked).toMatchObject({ ok: false })
  if (asked.ok) throw new Error('expected a question')
  expect(asked.reason).toContain('NODE_OPTIONS=--require ./x.js')
})
