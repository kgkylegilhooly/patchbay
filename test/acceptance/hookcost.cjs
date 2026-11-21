'use strict'
// Hooks on the real app, the way Claude Code runs them: with a Claude Code new enough, Patchbay has Claude start Node
// itself for each Node hook, with no Git Bash in front of it, and every status still comes through. With an older one
// the hooks stay the command lines they were, as sessions started before this have them, and those still work too. A
// custom Claude command from Settings is never run to ask its version, and keeps the command line.
//
// The agent is fake-claude.cjs, which runs the hooks from its settings as Claude Code would: no quota is used. For the
// first two runs it is the `claude` on the app's PATH, through a claude.cmd in a folder of its own, and every other
// folder holding a `claude` is left off that PATH, so no real Claude can start. Run after npm run build.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(5 * 60_000)
const fakeClaude = path.join(__dirname, 'fake-claude.cjs')

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** A PATH whose only `claude` is fake-claude, checked with where.exe before anything starts. */
function fakeClaudePath() {
  const bin = L.workDir('hookcost-bin')
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${fakeClaude}" %*\r\n`)
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH')
  const holdsClaude = (d) => ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'].some((n) => fs.existsSync(path.join(d, n)))
  const kept = process.env[key].split(';').filter((d) => d && !holdsClaude(d))
  const value = [bin, ...kept].join(';')
  const found = spawnSync('where.exe', ['claude'], { encoding: 'utf8', env: { ...process.env, [key]: value } }).stdout.split(/\r?\n/).filter(Boolean)
  if (found.length !== 1 || path.resolve(found[0]) !== path.resolve(bin, 'claude.cmd')) throw new Error(`Refusing to run: claude on the test PATH is ${JSON.stringify(found)}`)
  return { [key]: value }
}

async function run(label, { version, custom, expectForm }) {
  const cwd = L.workDir(`hookcost-${version}-${custom ? 'custom' : 'path'}`)
  const settings = { notifications: 'off', sound: 'off', ...(custom ? { claudeCommand: `node "${fakeClaude.replace(/\\/g, '/')}"` } : {}) }
  const profile = L.newProfile(settings)
  const log = path.join(profile, 'hooks.jsonl')
  const asked = path.join(profile, 'version.log')
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({ version: 3, projects: [{ id: 'p1', name: 'Hooks', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p1', viewport: { x: 20, y: 20, zoom: 1 }, edges: [], closed: [], nodes: [] }))
  const app = await L.launch({ profile, env: { FAKE_HOOK_LOG: log, FAKE_VERSION_LOG: asked, FAKE_CLAUDE_VERSION: version, ...fakeClaudePath() } })
  const page = app.page
  try {
    await L.openNode(page, L.claude('work', cwd, 0, 0, { projectId: 'p1', prompt: 'working' }))
    await L.openNode(page, L.claude('needs', cwd, 660, 0, { projectId: 'p1', prompt: 'needs' }))
    await L.openNode(page, L.claude('asks', cwd, 0, 460, { projectId: 'p1', prompt: 'permission' }))
    await L.openNode(page, L.claude('limit', cwd, 660, 460, { projectId: 'p1', prompt: 'limit' }))
    const want = { work: 'working', needs: 'needs-you', asks: 'needs-you', limit: 'unknown' }
    const got = await L.waitFor(`${label}: every status`, async () => {
      const s = await L.statuses(page)
      return Object.entries(want).every(([id, status]) => s[id] === status) ? s : null
    }, 45000).catch((e) => e.message)
    c.check(`${label}: working, needs you, a held permission request and a usage limit all arrive`, typeof got === 'object', got)
    const held = await L.approvals(page, 'asks')
    c.check(`${label}: the held permission request waits for an answer in Patchbay`, held.length === 1)
    const hooks = JSON.parse(fs.readFileSync(path.join(profile, 'sessions', 'work.settings.json'), 'utf8')).hooks
    const stop = hooks.Stop[0].hooks[0]
    c.check(
      `${label}: the settings ${expectForm === 'exec' ? 'start Node directly' : 'keep the command line'}`,
      expectForm === 'exec' ? Array.isArray(stop.args) && /node\.exe$/i.test(stop.command) : !stop.args && /^node "/.test(stop.command),
      stop
    )
    const askedTimes = fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8').split('\n').filter(Boolean).length : 0
    c.check(
      custom ? `${label}: the custom command was never run to ask its version` : `${label}: claude was asked its version once for all four agents`,
      askedTimes === (custom ? 0 : 1),
      askedTimes
    )
    const ran = readLog(log).filter((e) => e.name !== 'PermissionRequest')
    c.check(`${label}: every hook ran ${expectForm === 'exec' ? 'with no shell' : 'through Git Bash'} and exited 0`, ran.length >= 6 && ran.every((e) => e.form === expectForm && e.code === 0), ran)
    c.check(
      `${label}: limits: 30 s, 10 s for SessionEnd, 600 s for a held request`,
      ran.every((e) => e.timeout === 30) && hooks.SessionEnd[0].hooks[0].timeout === 10 && hooks.PermissionRequest[0].hooks[0].timeout === 600
    )
    const ms = ran.map((e) => e.ms).sort((a, b) => a - b)
    console.log(`      ${label}: ${ran.length} hooks, median ${ms[Math.floor(ms.length / 2)]} ms, slowest ${ms[ms.length - 1]} ms`)
    c.check(`${label}: no errors in the page`, app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
}

async function main() {
  await run('Claude Code 2.1.330', { version: '2.1.330', expectForm: 'exec' })
  await run('Claude Code 2.1.100', { version: '2.1.100', expectForm: 'shell' })
  await run('A custom Claude command', { version: '2.1.330', custom: true, expectForm: 'shell' })
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
