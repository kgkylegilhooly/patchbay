'use strict'
// Hooks on the real app, the way Claude Code runs them: with a Claude Code new enough, Patchbay has Claude start Node
// itself for each Node hook, with no Git Bash in front of it, and every status still comes through. With an older one
// the hooks stay the command lines they were, as sessions started before this have them, and those still work too.
// The agent is fake-claude.cjs, which runs the hooks from its settings as Claude Code would: no quota is used.
// Run after npm run build.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(4 * 60_000)
const fakeClaude = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

async function run(label, version, expectForm) {
  const cwd = L.workDir(`hookcost-${version}`)
  const profile = L.newProfile({ claudeCommand: `node "${fakeClaude}"`, notifications: 'off', sound: 'off' })
  const log = path.join(profile, 'hooks.jsonl')
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({ version: 3, projects: [{ id: 'p1', name: 'Hooks', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p1', viewport: { x: 20, y: 20, zoom: 1 }, edges: [], closed: [], nodes: [] }))
  const app = await L.launch({ profile, env: { FAKE_HOOK_LOG: log, FAKE_CLAUDE_VERSION: version } })
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
    c.check(`${label}: the held permission request waits for an answer in Patchbay`, held.length === 1, held.map((a) => a.toolName ?? a.tool_name))
    const settings = JSON.parse(fs.readFileSync(path.join(profile, 'sessions', 'work.settings.json'), 'utf8'))
    const stop = settings.hooks.Stop[0].hooks[0]
    c.check(
      `${label}: the settings ${expectForm === 'exec' ? 'start Node directly' : 'keep the command line'}`,
      expectForm === 'exec' ? Array.isArray(stop.args) && /node(\.exe)?$/i.test(stop.command) : !stop.args && /^node "/.test(stop.command),
      stop
    )
    const ran = readLog(log).filter((e) => e.name !== 'PermissionRequest')
    c.check(`${label}: every hook ran ${expectForm === 'exec' ? 'with no shell' : 'through Git Bash'} and exited 0`, ran.length >= 6 && ran.every((e) => e.form === expectForm && e.code === 0), ran)
    c.check(`${label}: no hook can time out on a slow start: 30 s, and 600 s for a held request`, ran.every((e) => e.timeout === 30) && settings.hooks.PermissionRequest[0].hooks[0].timeout === 600)
    const ms = ran.map((e) => e.ms).sort((a, b) => a - b)
    console.log(`      ${label}: ${ran.length} hooks, median ${ms[Math.floor(ms.length / 2)]} ms, slowest ${ms[ms.length - 1]} ms`)
    c.check(`${label}: no errors in the page`, app.problems.length === 0, app.problems)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
}

async function main() {
  await run('Claude Code 2.1.330', '2.1.330', 'exec')
  await run('Claude Code 2.1.100', '2.1.100', 'shell')
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
