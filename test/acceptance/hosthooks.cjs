'use strict'
// Hooks served by the session host, on the real app: with a Claude Code that has http hooks, every hook but
// SessionStart posts straight to the host, so nothing starts for it. Statuses, a held permission request answered in
// Patchbay, and the agent's context at SessionStart all work as before. With the app gone, events still answer at
// once (a permission request with no decision, so Claude's own prompt decides), go in the journal, and the next app
// shows the true status from it.
//
// The agent is fake-claude.cjs, which posts http hooks as Claude Code 2.1.330 does: no quota is used. It is the
// `claude` on the app's PATH through a claude.cmd in a folder of its own, and every other folder holding a `claude` is
// left off that PATH, so no real Claude can start. Run after npm run build.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(5 * 60_000)
const fakeClaude = path.join(__dirname, 'fake-claude.cjs')
const LATER_S = 25

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

function fakeClaudePath() {
  const bin = L.workDir('hosthooks-bin')
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "${fakeClaude}" %*\r\n`)
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH')
  const holdsClaude = (d) => ['claude', 'claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'].some((n) => fs.existsSync(path.join(d, n)))
  const kept = process.env[key].split(';').filter((d) => d && !holdsClaude(d))
  const value = [bin, ...kept].join(';')
  const found = spawnSync('where.exe', ['claude'], { encoding: 'utf8', env: { ...process.env, [key]: value } }).stdout.split(/\r?\n/).filter(Boolean)
  if (found.length !== 1 || path.resolve(found[0]) !== path.resolve(bin, 'claude.cmd')) throw new Error(`Refusing to run: claude on the test PATH is ${JSON.stringify(found)}`)
  return { [key]: value }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function main() {
  const cwd = L.workDir('hosthooks')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const log = path.join(profile, 'hooks.jsonl')
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({ version: 3, projects: [{ id: 'p1', name: 'Hooks', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p1', viewport: { x: 20, y: 20, zoom: 1 }, edges: [], closed: [], nodes: [] }))
  const env = { FAKE_HOOK_LOG: log, FAKE_CLAUDE_VERSION: '2.1.330', ...fakeClaudePath() }
  let app = await L.launch({ profile, env })
  try {
    let page = app.page
    await L.openNode(page, L.claude('work', cwd, 0, 0, { projectId: 'p1', prompt: 'working' }))
    await L.openNode(page, L.claude('needs', cwd, 660, 0, { projectId: 'p1', prompt: 'needs' }))
    await L.openNode(page, L.claude('asks', cwd, 0, 460, { projectId: 'p1', prompt: 'permission' }))
    await L.openNode(page, L.claude('limit', cwd, 660, 460, { projectId: 'p1', prompt: 'limit' }))
    await L.openNode(page, L.claude('later', cwd, 1320, 0, { projectId: 'p1', prompt: `later=${LATER_S}` }))
    const want = { work: 'working', needs: 'needs-you', asks: 'needs-you', limit: 'unknown', later: 'working' }
    const got = await L.waitFor('every status', async () => {
      const s = await L.statuses(page)
      return Object.entries(want).every(([id, status]) => s[id] === status) ? s : null
    }, 45000).catch((e) => e.message)
    c.check('working, needs you, a held permission request, a usage limit and a turn under way all arrive', typeof got === 'object', got)

    const hostInfo = JSON.parse(fs.readFileSync(path.join(profile, 'control', 'host.json'), 'utf8'))
    const hooks = JSON.parse(fs.readFileSync(path.join(profile, 'sessions', 'work.settings.json'), 'utf8')).hooks
    const http = Object.entries(hooks).filter(([e]) => e !== 'SessionStart').map(([, h]) => h[0].hooks[0])
    c.check('the host serves hooks on a port it wrote down', typeof hostInfo.hookPort === 'number', hostInfo)
    c.check('every hook but SessionStart posts to that port', http.every((h) => h.type === 'http' && h.url.startsWith(`http://127.0.0.1:${hostInfo.hookPort}/hook/`)), http)
    c.check('SessionStart stays a command, Node started directly', hooks.SessionStart[0].hooks[0].type === 'command' && Array.isArray(hooks.SessionStart[0].hooks[0].args), hooks.SessionStart)

    // The agent's context still arrives at SessionStart: whoami works only once the app has taken that hook.
    const ctxNode = (await L.doc(page)).nodes.find((n) => n.id === 'work')
    c.check('SessionStart still reached the app, which recorded the session', !!ctxNode?.sessionId, ctxNode)

    const held = await L.approvals(page, 'asks')
    c.check('the held permission request waits in Patchbay', held.length === 1, held)
    if (held[0]) await page.evaluate((id) => window.patchbay.answerApproval(id, 'allow'), held[0].requestId ?? held[0].id)
    const answered = await L.waitFor('the answer back in Claude', async () => readLog(log).find((e) => e.node === 'asks' && e.name === 'PermissionRequest'), 15000).catch(() => null)
    c.check("the person's answer reached Claude as its hook output", !!answered && JSON.parse(answered.answer || '{}')?.hookSpecificOutput?.decision?.behavior === 'allow', answered)

    const live = readLog(log).filter((e) => e.form === 'http' && e.name !== 'PermissionRequest')
    c.check('every http hook was answered 200', live.length >= 7 && live.every((e) => e.code === 200), live)
    const shell = readLog(log).filter((e) => e.form !== 'http')
    c.check('only SessionStart started a program: one per session', shell.length === 5 && shell.every((e) => e.name === 'SessionStart' && e.form === 'exec'), shell)
    console.log(`      live: ${live.length} http hooks, median ${median(live.map((e) => e.ms))} ms, slowest ${Math.max(...live.map((e) => e.ms))} ms; SessionStart (exec) median ${median(shell.map((e) => e.ms))} ms`)
    c.check('no errors in the page', app.problems.length === 0, app.problems)

    // The app goes, leaving the sessions running in the host. Ended as a crash ends it: a quit would first ask about the
    // agents still working. "later" asks and ends its turn while no app is there.
    const quitAt = Date.now()
    await app.forceKill()
    c.check('the app went with its turn still under way, and the host carries on', Date.now() - quitAt < LATER_S * 1000 && !!L.hostPid(profile))
    const whileAway = await L.waitFor('the turn ending with no app', async () => {
      const mine = readLog(log).filter((e) => e.node === 'later' && e.at > quitAt)
      return mine.some((e) => e.name === 'Stop') ? mine : null
    }, (LATER_S + 20) * 1000).catch(() => null)
    const asked = whileAway?.find((e) => e.name === 'PermissionRequest')
    c.check('with no app, a permission request gets no decision at once, so Claude\'s own prompt decides', !!asked && asked.code === 200 && asked.answer === '{}' && asked.ms < 1000, asked)
    c.check('with no app, every hook is still answered 200, quickly', !!whileAway && whileAway.every((e) => e.code === 200 && e.ms < 1000), whileAway)
    const journal = path.join(profile, 'control', 'missed', 'later.jsonl')
    const journalled = await L.waitFor('the journal', async () => {
      const lines = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : ''
      return /"Stop"/.test(lines) ? lines : null
    }, 20000).catch(() => null)
    c.check('the host journalled what no app took, as hook.cjs does', !!journalled && /PermissionRequest/.test(journalled) && !/npm test/.test(journalled), journalled)

    app = await L.launch({ profile, env })
    page = app.page
    const after = await L.waitFor('the true status after reopening', async () => ((await L.statuses(page)).later === 'idle' ? true : null), 30000).catch(() => false)
    c.check('the next app reads the journal and shows the turn ended', after === true, await L.statuses(page))
    c.check('no errors in the reopened page', app.problems.length === 0, app.problems)
  } finally {
    // No quit question: the app and this profile's own host are ended directly.
    await app.forceKill().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
