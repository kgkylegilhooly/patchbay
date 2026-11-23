'use strict'
// Milestone 2: sessions outlive the app. Drives the real app and its real background host on throwaway profiles.
//
//   node test/acceptance/host.cjs                 the built app, with no Claude quota used
//   node test/acceptance/host.cjs --packaged      the same against release/win-unpacked
//   node test/acceptance/host.cjs --real-claude   also runs a real Claude session through a reattach
//
// Claude's part is played by a small script that runs the real resources/hook.cjs when told to, so the hook path is
// the real one and the timing is under this script's control.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const lib = require('./lib.cjs')
const { sleep, waitFor, launch, doc, statuses, snapshot, input, openNode, terminal, claude, approvals, checker, newProfile, workDir, cleanup, hostPid, alive, packagedExe, root } = lib

const packaged = process.argv.includes('--packaged')
const realClaude = process.argv.includes('--real-claude')
const exe = packaged ? packagedExe : undefined
const hookScript = path.join(root, 'resources', 'hook.cjs')
const cliScript = path.join(root, 'resources', 'cli', 'patchbay.cjs')

/** Every run has a ceiling, so a stuck app fails this script rather than holding it up for ever. */
const OVERALL_LIMIT_MS = 12 * 60 * 1000
setTimeout(() => {
  console.error('FAIL  the whole run went over its time limit')
  process.exit(2)
}, OVERALL_LIMIT_MS).unref()

const hostInfo = (page) => page.evaluate(() => window.patchbay.getHostInfo())

/** Prints a numbered line every 100 ms, and notes its own pid, so nothing about the count can be faked by a redraw. */
function writeCounter(work) {
  const file = path.join(work, 'counter.cjs')
  fs.writeFileSync(
    file,
    `const fs = require('fs')
fs.writeFileSync(${JSON.stringify(path.join(work, 'counter.pid'))}, String(process.pid))
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(path.join(work, 'counter.typed'))}, d))
let n = 0
setInterval(() => {
  n++
  fs.writeFileSync(${JSON.stringify(path.join(work, 'counter.last'))}, String(n))
  process.stdout.write('count ' + n + ' end\\n')
}, 100)
`
  )
  return file
}

/**
 * Stands in for Claude. Typing "hook NAME" runs the real hook now, and "later MS NAME" runs it once that long has
 * passed, which can be while the app is closed. Each result goes in a log file, as nothing may be reading the screen.
 */
function writeFakeClaude(work) {
  const file = path.join(work, 'fake-claude.cjs')
  const log = path.join(work, 'hook-results.log')
  fs.writeFileSync(
    file,
    `const { spawn } = require('child_process')
const fs = require('fs')
const readline = require('readline')
function hook(name) {
  const start = Date.now()
  const child = spawn(process.execPath, [${JSON.stringify(hookScript)}, name], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.on('close', (code) => {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name, code, out, ms: Date.now() - start }) + '\\n')
  })
  const event = { hook_event_name: name, session_id: 'fake-session', transcript_path: 'C:/nowhere/fake.jsonl', source: 'startup' }
  if (name === 'PermissionRequest') Object.assign(event, { tool_name: 'Bash', tool_input: { command: 'echo hi' } })
  child.stdin.end(JSON.stringify(event))
}
process.stdin.setEncoding('utf8')
process.stdin.setRawMode && process.stdin.setRawMode(true)
let line = ''
process.stdin.on('data', (d) => {
  for (const ch of d) {
    if (ch !== '\\r' && ch !== '\\n') { line += ch; continue }
    const [verb, a, b] = line.trim().split(' ')
    line = ''
    if (verb === 'hook') hook(a)
    if (verb === 'later') setTimeout(() => hook(b), Number(a))
  }
})
process.stdout.write('fake claude ready\\n')
setInterval(() => {}, 1000)
`
  )
  return { file, log }
}

const hookResults = (log, name) => {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.name === name)
}

/** Every count in order, as it appears in the session's stream, and what's wrong with the run of them. */
function counts(text) {
  const seen = [...text.matchAll(/count (\d+) end/g)].map((m) => Number(m[1]))
  const problems = []
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] === seen[i - 1]) problems.push(`duplicate ${seen[i]}`)
    else if (seen[i] < seen[i - 1]) problems.push(`backward ${seen[i - 1]} to ${seen[i]}`)
    else if (seen[i] !== seen[i - 1] + 1) problems.push(`gap ${seen[i - 1]} to ${seen[i]}`)
  }
  return { first: seen[0], last: seen[seen.length - 1], total: seen.length, problems }
}

const readInt = (file) => Number(fs.readFileSync(file, 'utf8'))

/** The counter is a real, separate process: its file moves on only if it's really still running. */
async function counterAdvances(work, ms = 2000) {
  const before = readInt(path.join(work, 'counter.last'))
  await sleep(ms)
  return readInt(path.join(work, 'counter.last')) > before
}

async function counterReached(page, work, id) {
  return waitFor('the counter to reach a live view', async () => {
    const c = counts(await snapshot(page, id))
    return c.last >= readInt(path.join(work, 'counter.last')) - 20 ? c : null
  }, 20000)
}

/** One piece of the run. A failure is reported and the rest still run, and its profile is always cleaned up. */
async function section(c, name, profiles, body) {
  console.log(`\n--- ${name}`)
  try {
    await body()
  } catch (e) {
    c.check(`${name}: finished without an error`, false, e.message)
  } finally {
    for (const p of profiles) cleanup(p)
  }
}

async function survives(c) {
  const work = workDir('host-survive')
  const profile = newProfile()
  await section(c, 'Quit, force-kill, close and stop', [profile], async () => {
    const counter = writeCounter(work)
    let app = await launch({ profile, exe })
    // The window doesn't wait for a new host to start, so it may still be on its way.
    let info = await waitFor('the host to start', async () => {
      const i = await hostInfo(app.page)
      return i.mode === 'starting' ? null : i
    }, 30000).catch(() => hostInfo(app.page))
    c.check('the host is running after launch', info.mode === 'background' && alive(info.pid), info)
    c.check('the host is a separate process', info.pid !== app.child.pid)
    const host = info.pid
    await openNode(app.page, terminal('count', work, 40, 40, { command: `node "${counter.replace(/\\/g, '/')}"` }))
    await waitFor('counting to start', async () => counts(await snapshot(app.page, 'count')).total >= 5, 30000)
    const counterPid = readInt(path.join(work, 'counter.pid'))
    const before = counts(await snapshot(app.page, 'count'))
    c.check('Settings has the session counted', (await hostInfo(app.page)).running === 1)

    // Quit.
    c.check('quit exits 0', (await app.quitLeavingSessions()) === 0)
    c.check('quit: the host is still alive', alive(host))
    c.check('quit: the counting process is still alive', alive(counterPid))
    c.check('quit: its count keeps moving with the app closed', await counterAdvances(work))
    c.check('quit: no endpoint file is left to mislead a session', !fs.existsSync(path.join(profile, 'control', 'endpoint.json')))

    app = await launch({ profile, exe })
    info = await hostInfo(app.page)
    c.check('relaunch: it joined the same host', info.mode === 'background' && info.pid === host, info)
    c.check('relaunch: the same process is still counting', alive(counterPid) && readInt(path.join(work, 'counter.pid')) === counterPid)
    const afterQuit = await counterReached(app.page, work, 'count')
    c.check('relaunch: no gap, repeat or reorder in the whole stream', afterQuit.problems.length === 0, afterQuit.problems.slice(0, 5))
    c.check('relaunch: it starts from the same first line', afterQuit.first === before.first, `${afterQuit.first} vs ${before.first}`)
    c.check('relaunch: it has what was printed while closed', afterQuit.last > before.last + 15, `${before.last} to ${afterQuit.last}`)
    const shown = await waitFor('the window to show the count', async () => {
      const rows = (await lib.screen(app.page, 'count')).join('\n')
      return /count \d+ end/.test(rows) ? rows : null
    }, 15000)
    c.check('relaunch: the window shows it, with no divider', shown && !(await snapshot(app.page, 'count')).includes('process ended'))
    c.check('relaunch: a running terminal has no exited status', (await statuses(app.page)).count === undefined)
    const typed = 'typed-after-reattach'
    await input(app.page, 'count', `${typed}\r`)
    await waitFor('input to reach the session', () => fs.readFileSync(path.join(work, 'counter.typed'), 'utf8').includes(typed), 10000).then(
      () => c.check('relaunch: typing reaches the session', true),
      () => c.check('relaunch: typing reaches the session', false)
    )

    // Force-kill, including its process tree, as Task Manager's End process tree would.
    await app.forceKill()
    c.check('force-kill: the host survives', alive(host))
    c.check('force-kill: the counting process survives', alive(counterPid))
    c.check('force-kill: its count keeps moving', await counterAdvances(work))
    app = await launch({ profile, exe })
    info = await hostInfo(app.page)
    c.check('after force-kill: it joined the same host', info.pid === host, info)
    const afterKill = await counterReached(app.page, work, 'count')
    c.check('after force-kill: no gap, repeat or reorder', afterKill.problems.length === 0, afterKill.problems.slice(0, 5))
    c.check('after force-kill: it has what was printed meanwhile', afterKill.last > afterQuit.last, `${afterQuit.last} to ${afterKill.last}`)

    // Closing a node ends its session.
    await openNode(app.page, terminal('other', work, 600, 40))
    await waitFor('a second session', async () => (await hostInfo(app.page)).running === 2, 15000)
    await app.page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['count'], at: Date.now() }))
    await waitFor('the closed node\'s process to end', () => !alive(counterPid), 15000).then(
      () => c.check('close: the node\'s process is gone', true),
      () => c.check('close: the node\'s process is gone', false, counterPid)
    )
    c.check('close: the host and the other session stay', alive(host) && (await hostInfo(app.page)).running === 1)
    const stale = readInt(path.join(work, 'counter.last'))
    await sleep(600)
    c.check('close: its count has stopped', readInt(path.join(work, 'counter.last')) === stale)

    // A session that dies with the host comes back from saved output, with the divider.
    await openNode(app.page, terminal('saved', work, 40, 400, { command: 'echo keep-this-line-77' }))
    await waitFor('output to save', () => {
      const dir = path.join(profile, 'scrollback')
      return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith('saved') && fs.readFileSync(path.join(dir, f), 'utf8').includes('keep-this-line-77'))
    }, 20000)
    await app.page.evaluate(() => window.patchbay.stopHost())
    await waitFor('the host to end', () => !alive(host), 15000)
    c.check('stop: the host is gone', !alive(host))
    info = await hostInfo(app.page)
    c.check('stop: Settings says it is stopped, with nothing running', info.mode === 'stopped' && info.running === 0, info)
    const exited = await statuses(app.page)
    c.check('stop: terminals read as exited', exited.other === 'exited' && exited.saved === 'exited', exited)
    c.check('stop: the app stays open', !(await Promise.race([app.exited.then(() => true), sleep(300).then(() => false)])))
    c.check('quit exits 0 with the host stopped', (await app.quitLeavingSessions()) === 0)

    app = await launch({ profile, exe })
    info = await hostInfo(app.page)
    c.check('clean restore: a new host', info.mode === 'background' && info.pid !== host && alive(info.pid), info)
    const back = await waitFor('the restored terminal', async () => {
      const text = await snapshot(app.page, 'saved')
      return text.includes('process ended') ? text : null
    }, 15000)
    c.check('clean restore: saved output comes first, then the divider', back.indexOf('keep-this-line-77') !== -1 && back.indexOf('keep-this-line-77') < back.indexOf('process ended'))
    c.check('clean restore: it is running again', await app.page.evaluate(() => window.patchbay.getHostInfo()).then((i) => i.running === 2))
    c.check('clean quit exits 0', (await app.quit()) === 0)
    await waitFor('stopping everything to end the host', () => !hostPid(profile), 15000)
    c.check('Stop all sessions and quit leaves no host behind', !hostPid(profile))
    c.check('no page errors', app.problems.length === 0, app.problems.slice(0, 3))
  })
}

async function status(c) {
  const work = workDir('host-status')
  const fake = writeFakeClaude(work)
  const profile = newProfile({ claudeCommand: `"${process.execPath}" "${fake.file}"` })
  await section(c, 'Status and hooks with the app closed', [profile], async () => {
    let app = await launch({ profile, exe })
    await openNode(app.page, claude('c', work, 40, 40))
    await waitFor('the stand-in to start', async () => (await snapshot(app.page, 'c')).includes('fake claude ready'), 30000)
    const say = async (page, line) => {
      await input(page, 'c', line)
      await input(page, 'c', '\r')
    }
    await say(app.page, 'hook SessionStart')
    await waitFor('idle', async () => (await statuses(app.page)).c === 'idle', 10000)
    c.check('live hooks reach the app', true)

    // Nothing is heard while the app is away, so nothing can be claimed afterward.
    c.check('quit exits 0', (await app.quitLeavingSessions()) === 0)
    app = await launch({ profile, exe })
    c.check('a session with nothing to confirm it shows unknown, not idle', (await statuses(app.page)).c === 'unknown', await statuses(app.page))
    await sleep(3500)
    c.check('it still does after the late journal check', (await statuses(app.page)).c === 'unknown')
    await say(app.page, 'hook UserPromptSubmit')
    await waitFor('a later hook to work', async () => (await statuses(app.page)).c === 'working', 10000)
    c.check('hooks find the new endpoint with no restart of the session', true)

    // A turn finishing while the app is closed.
    await say(app.page, 'later 1500 Stop')
    await sleep(200)
    // Claude reads as working, so a clean quit would stop to ask. A crash doesn't.
    await app.forceKill()
    await waitFor('the hook to run with no app there', () => hookResults(fake.log, 'Stop').length === 1, 15000)
    const stop = hookResults(fake.log, 'Stop')[0]
    c.check('a hook with no app exits 0 quietly', stop.code === 0 && stop.out === '', stop)
    c.check('a hook after a crash does not wait on the dead port', stop.ms < 1000, `${stop.ms} ms`)
    app = await launch({ profile, exe })
    await waitFor('the journal to be read', async () => (await statuses(app.page)).c === 'idle', 8000).then(
      () => c.check('a turn that ended while closed reads as idle, from its own hook', true),
      async () => c.check('a turn that ended while closed reads as idle, from its own hook', false, await statuses(app.page))
    )
    const node = await lib.nodeOf(app.page, 'c')
    c.check('the session id reported while closed is kept', node.sessionId === 'fake-session', node.sessionId)

    // An approval with nobody to ask.
    await say(app.page, 'later 1500 PermissionRequest')
    await sleep(200)
    c.check('quit exits 0 with Claude idle, so with no question', (await app.quitLeavingSessions()) === 0)
    await waitFor('the permission hook to run with no app there', () => hookResults(fake.log, 'PermissionRequest').length === 1, 15000)
    const asked = hookResults(fake.log, 'PermissionRequest')[0]
    c.check('a permission request with the app closed gets no answer, leaving Claude\'s own prompt', asked.code === 0 && asked.out === '', asked)
    c.check('and does not hold the session up', asked.ms < 1000, `${asked.ms} ms`)
    app = await launch({ profile, exe })
    await waitFor('needs-you', async () => (await statuses(app.page)).c === 'needs-you', 8000).then(
      () => c.check('it shows as needing you after reconnecting', true),
      async () => c.check('it shows as needing you after reconnecting', false, await statuses(app.page))
    )
    c.check('with no buttons that could no longer answer it', (await approvals(app.page, 'c')).length === 0)

    // A request being held when the app goes.
    await say(app.page, 'hook PermissionRequest')
    await waitFor('the buttons', async () => (await approvals(app.page, 'c')).length === 1, 10000)
    c.check('with the app open the request is held for the buttons', hookResults(fake.log, 'PermissionRequest').length === 1)
    await app.forceKill()
    await waitFor('the held hook to let go', () => hookResults(fake.log, 'PermissionRequest').length === 2, 8000)
    const held = hookResults(fake.log, 'PermissionRequest')[1]
    c.check('the app dying mid-request falls back to Claude\'s own prompt', held.code === 0 && held.out === '', held)

    // The CLI with no app.
    app = await launch({ profile, exe })
    await waitFor('the held request to read as needing you', async () => (await statuses(app.page)).c === 'needs-you', 8000)
    await say(app.page, 'hook Stop')
    await waitFor('idle again, so quitting has nothing to ask', async () => (await statuses(app.page)).c === 'idle', 8000)
    c.check('quit exits 0', (await app.quitLeavingSessions()) === 0)
    const started = Date.now()
    const cli = spawnSync(process.execPath, [cliScript, 'list'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, PATCHBAY_ENDPOINT_FILE: path.join(profile, 'control', 'endpoint.json'), PATCHBAY_NODE_ID: 'c', PATCHBAY_TOKEN: 'x' }
    })
    c.check('the CLI with the app closed says so, and fast', cli.status === 1 && /app is closed/.test(cli.stderr) && Date.now() - started < 3000, cli.stderr.trim())

    app = await launch({ profile, exe })
    await waitFor('the session to be joined', async () => (await hostInfo(app.page)).running === 1, 10000)
    c.check('clean quit exits 0', (await app.quit()) === 0)
    c.check('no page errors', app.problems.length === 0, app.problems.slice(0, 3))
  })
}

async function otherVersion(c) {
  const work = workDir('host-version')
  const counter = writeCounter(work)
  const profile = newProfile()
  await section(c, 'An older host and a newer app', [profile], async () => {
    // Told it's another version, the app and the host it starts agree with each other: this is that older pair.
    let app = await launch({ profile, exe, env: { PATCHBAY_HOST_PROTOCOL: '998' } })
    await openNode(app.page, terminal('count', work, 40, 40, { command: `node "${counter.replace(/\\/g, '/')}"` }))
    await waitFor('counting', async () => counts(await snapshot(app.page, 'count')).total >= 3, 30000)
    const older = (await hostInfo(app.page)).pid
    const pid = readInt(path.join(work, 'counter.pid'))
    c.check('quit exits 0, leaving the older host running', (await app.quitLeavingSessions()) === 0)

    // The app has been updated.
    app = await launch({ profile, exe })
    const info = await hostInfo(app.page)
    c.check('the app reports it rather than touching it', info.mode === 'other-version' && info.pid === older && info.running === 1, info)
    c.check('it says so in words', /another version/.test(info.problem ?? ''), info.problem)
    await sleep(1500)
    c.check('nothing has been stopped without asking', alive(older) && alive(pid))
    c.check('its session is still counting', await counterAdvances(work))
    const errors = await app.page.evaluate(() => window.patchbay.getErrors())
    c.check('a node waiting on the choice says why', /older session host/.test(errors.count?.message ?? ''), errors.count)

    // Choosing to leave it: the app goes, and it's untouched.
    const leaving = app.page.evaluate(() => window.patchbay.resolveOtherHost('quit')).catch(() => {})
    const code = await Promise.race([app.exited, sleep(20000).then(() => 'timeout')])
    await leaving
    app.browser.disconnect()
    c.check('quitting instead exits 0', code === 0, code)
    c.check('and leaves it running', alive(older) && alive(pid))

    // Choosing to stop it.
    app = await launch({ profile, exe })
    await app.page.evaluate(() => window.patchbay.resolveOtherHost('stop-it'))
    await waitFor('the older host to end, by choice', () => !alive(older), 15000)
    c.check('its session ends with it', await waitFor('its session to end', () => !alive(pid), 10000))
    const now = await waitFor('the new host', async () => {
      const i = await hostInfo(app.page)
      return i.mode === 'background' && i.running === 1 ? i : null
    }, 20000)
    c.check('a new host brings the node back', now.pid !== older && now.protocol === now.expectedProtocol, now)
    c.check('the error is gone', (await app.page.evaluate(() => window.patchbay.getErrors())).count === undefined)
    const text = await snapshot(app.page, 'count')
    c.check('its output is below the saved one, with the divider', /count \d+ end/.test(text) && text.includes('process ended'))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  })
}

async function fallback(c) {
  const work = workDir('host-fallback')
  const profile = newProfile()
  await section(c, 'The host cannot start', [profile], async () => {
    const started = Date.now()
    const app = await launch({ profile, exe, env: { PATCHBAY_HOST_SCRIPT: path.join(work, 'no-such-host.js') } })
    c.check('the app opens anyway', true, `${Date.now() - started} ms`)
    // The window doesn't wait for a new host to start, so it learns the host failed once it has.
    const info = await waitFor('the host to be given up on', async () => {
      const i = await hostInfo(app.page)
      return i.mode === 'starting' ? null : i
    }, 30000).catch(() => hostInfo(app.page))
    c.check('it says what happened', info.mode === 'in-process' && /end when it quits/.test(info.problem ?? ''), info)
    await openNode(app.page, terminal('t', work, 40, 40, { command: 'echo works-without-a-host' }))
    await waitFor('the terminal to work', async () => (await snapshot(app.page, 't')).includes('works-without-a-host'), 20000)
    c.check('a terminal works without a host', true)
    c.check('clean quit exits 0', (await app.quit()) === 0)
    c.check('no host was left', !hostPid(profile))
  })
}

async function orphan(c) {
  const work = workDir('host-orphan')
  const counter = writeCounter(work)
  const profile = newProfile()
  await section(c, 'When a host has been left behind', [profile], async () => {
    const limits = JSON.stringify({ orphanMs: 3000, tickMs: 300 })
    let app = await launch({ profile, exe, env: { PATCHBAY_HOST_LIMITS: limits } })
    await openNode(app.page, terminal('count', work, 40, 40, { command: `node "${counter.replace(/\\/g, '/')}"` }))
    await waitFor('counting', async () => counts(await snapshot(app.page, 'count')).total >= 3, 30000)
    const pid = readInt(path.join(work, 'counter.pid'))
    const host = (await hostInfo(app.page)).pid
    await sleep(4000)
    c.check('with an app connected, past the limit, nothing ends', alive(host) && alive(pid))
    const atQuit = counts(await snapshot(app.page, 'count')).last
    c.check('quit exits 0', (await app.quitLeavingSessions()) === 0)
    await waitFor('the orphan limit to end the host', () => !alive(host), 15000)
    c.check('with nobody connected past the limit, the host ends', true)
    await waitFor('its session to end too', () => !alive(pid), 10000)
    c.check('and so does its session', true)
    c.check('the log says why', /policy: orphaned/.test(fs.readFileSync(path.join(profile, 'control', 'host.log'), 'utf8')))
    const last = readInt(path.join(work, 'counter.last'))
    app = await launch({ profile, exe })
    const text = await waitFor('the restored terminal', async () => {
      const t = await snapshot(app.page, 'count')
      return t.includes('process ended') ? t : null
    }, 20000)
    const seen = counts(text.slice(0, text.indexOf('process ended')))
    c.check('restored output includes what was printed with the app closed', seen.last > atQuit + 10, `quit at ${atQuit}, restored to ${seen.last}, reached ${last}`)
    c.check('with nothing out of order', seen.problems.length === 0, seen.problems.slice(0, 5))
    c.check('the command did not run again by itself', readInt(path.join(work, 'counter.last')) === last)
    c.check('clean quit exits 0', (await app.quit()) === 0)
  })
}

async function dataGone(c) {
  const work = workDir('host-gone')
  const counter = writeCounter(work)
  const profile = newProfile()
  await section(c, 'The profile is deleted out from under a host', [profile], async () => {
    const limits = JSON.stringify({ dataGoneMs: 1500, tickMs: 300 })
    const app = await launch({ profile, exe, env: { PATCHBAY_HOST_LIMITS: limits } })
    await openNode(app.page, terminal('count', work, 40, 40, { command: `node "${counter.replace(/\\/g, '/')}"` }))
    await waitFor('counting', async () => counts(await snapshot(app.page, 'count')).total >= 3, 30000)
    const host = (await hostInfo(app.page)).pid
    const pid = readInt(path.join(work, 'counter.pid'))
    c.check('quit exits 0', (await app.quitLeavingSessions()) === 0)
    await sleep(500)
    let removed = false
    for (let i = 0; i < 20 && !removed; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true })
        removed = !fs.existsSync(profile)
      } catch {
        await sleep(500)
      }
    }
    c.check('the host holds nothing open that stops the profile being deleted', removed)
    await waitFor('the host to end', () => !alive(host), 15000)
    c.check('the host ends', true)
    await waitFor('its session to end', () => !alive(pid), 10000)
    c.check('its session ends', true)
    c.check('it did not bring the folder back', !fs.existsSync(profile))
  })
}

async function hostLost(c) {
  const work = workDir('host-lost')
  const profile = newProfile()
  await section(c, 'The host dies with the app open', [profile], async () => {
    const app = await launch({ profile, exe })
    await openNode(app.page, terminal('t', work, 40, 40, { command: 'echo before-the-crash' }))
    await waitFor('output', async () => (await snapshot(app.page, 't')).includes('before-the-crash'), 20000)
    const host = (await hostInfo(app.page)).pid
    // This throwaway profile's own host, by the pid it reported.
    spawnSync('taskkill', ['/pid', String(host), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
    const info = await waitFor('the app to notice', async () => {
      const i = await hostInfo(app.page)
      return i.mode === 'stopped' ? i : null
    }, 15000)
    c.check('the app says so rather than going quiet', /stopped unexpectedly/.test(info.problem ?? ''), info)
    c.check('its terminal reads as exited', (await statuses(app.page)).t === 'exited')
    c.check('its output is still there', (await snapshot(app.page, 't')).includes('before-the-crash'))
    await app.page.evaluate(() => window.patchbay.restartNode('t'))
    const next = await waitFor('a new host', async () => {
      const i = await hostInfo(app.page)
      return i.mode === 'background' && i.running === 1 ? i : null
    }, 20000)
    c.check('restarting the node starts a new host by itself', next.pid !== host && alive(next.pid), next)
    c.check('with its old output still above', (await snapshot(app.page, 't')).includes('before-the-crash'))
    c.check('clean quit exits 0', (await app.quit()) === 0)
  })
}

async function profiles(c) {
  const work = workDir('host-profiles')
  const a = newProfile()
  const b = newProfile()
  await section(c, 'Two profiles at once', [a, b], async () => {
    const first = await launch({ profile: a, exe })
    const second = await launch({ profile: b, exe })
    const ia = await hostInfo(first.page)
    const ib = await hostInfo(second.page)
    c.check('each gets its own host', ia.pid !== ib.pid && alive(ia.pid) && alive(ib.pid), [ia.pid, ib.pid])
    await openNode(first.page, terminal('only-a', work, 40, 40))
    await waitFor('a session on the first', async () => (await hostInfo(first.page)).running === 1, 15000)
    c.check('the other sees none of its sessions', (await hostInfo(second.page)).running === 0)
    c.check('clean quit exits 0', (await first.quit()) === 0)
    c.check('clean quit exits 0', (await second.quit()) === 0)
  })
}

/** One noisy terminal must not make the canvas stutter, and must not run away with memory. */
async function noisy(c) {
  const work = workDir('host-noisy')
  const script = path.join(work, 'noisy.cjs')
  // Writes as fast as the terminal will take it, which is the worst a program can do.
  fs.writeFileSync(script, `const line = 'x'.repeat(100) + '\\n'\nfunction go() { while (process.stdout.write(line)); process.stdout.once('drain', go) }\ngo()\n`)
  const profile = newProfile()
  await section(c, 'A noisy terminal', [profile], async () => {
    const app = await launch({ profile, exe })
    const frames = () =>
      app.page.evaluate(
        () =>
          new Promise((resolve) => {
            const gaps = []
            let last = performance.now()
            const end = last + 4000
            const tick = (t) => {
              gaps.push(t - last)
              last = t
              if (t < end) requestAnimationFrame(tick)
              else resolve(gaps)
            }
            requestAnimationFrame(tick)
          })
      )
    const summary = (gaps) => {
      const sorted = [...gaps].sort((x, y) => x - y)
      return { frames: gaps.length, p50: Math.round(sorted[Math.floor(sorted.length * 0.5)]), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]), max: Math.round(sorted[sorted.length - 1]) }
    }
    await openNode(app.page, terminal('quiet', work, 40, 40))
    await sleep(1500)
    const quiet = summary(await frames())
    await openNode(app.page, terminal('loud', work, 600, 40, { command: `node "${script.replace(/\\/g, '/')}"` }))
    await waitFor('output to flow', async () => (await snapshot(app.page, 'loud')).length > 100000, 30000)
    const loud = summary(await frames())
    c.check('measured: frame times', true, { quiet, loud })
    c.check('the canvas keeps its frame rate within reason with a noisy terminal (p95 under 50 ms)', loud.p95 < 50, loud)
    const host = (await hostInfo(app.page)).pid
    await sleep(3000)
    const rss = () => spawnSync('tasklist', ['/FI', `PID eq ${host}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10000 }).stdout
    const memory = Number((/"([\d,. ]+) K/.exec(rss())?.[1] ?? '0').replace(/[^\d]/g, '')) / 1024
    c.check('the host\'s memory stays bounded under the flood', memory > 0 && memory < 400, `${Math.round(memory)} MB`)
    await input(app.page, 'quiet', 'echo still-answering-99\r')
    await waitFor('the quiet terminal to answer', async () => (await snapshot(app.page, 'quiet')).includes('still-answering-99'), 10000).then(
      () => c.check('a quiet terminal still answers during the flood', true),
      () => c.check('a quiet terminal still answers during the flood', false)
    )
    await app.page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['loud'], at: Date.now() }))
    await waitFor('the noisy session to end', async () => (await hostInfo(app.page)).running === 1, 15000)
    c.check('clean quit exits 0', (await app.quit()) === 0)
  })
}

async function real(c) {
  const work = workDir('host-real-claude')
  const profile = newProfile({ permissionMode: 'default' })
  await section(c, 'A real Claude session', [profile], async () => {
    let app = await launch({ profile, exe })
    await openNode(app.page, claude('c', root, 40, 40, { width: 800, height: 500 }))
    await waitFor('Claude to start', async () => (await statuses(app.page)).c === 'idle', 90000)
    await lib.submit(app.page, 'c', 'Reply with exactly the word PINEAPPLE and nothing else. Use no tools.')
    // The prompt has the word in it too, so only the status can say the turn has really finished.
    await waitFor('the turn to start', async () => (await lib.seenStatuses(app.page, 'c')).includes('working'), 60000)
    await waitFor('the reply', async () => (await statuses(app.page)).c === 'idle', 120000)
    const node = await lib.nodeOf(app.page, 'c')
    c.check('quit with Claude idle exits 0', (await app.quitLeavingSessions()) === 0)
    app = await launch({ profile, exe })
    c.check('after reconnecting its status is unknown, not a guessed idle', (await statuses(app.page)).c === 'unknown', await statuses(app.page))
    const repainted = await waitFor('the screen to come back', async () => {
      const rows = (await lib.screen(app.page, 'c')).join('\n')
      return rows.includes('PINEAPPLE') ? rows : null
    }, 30000)
    c.check('its screen comes back with the conversation on it', !!repainted)
    await lib.shot(app.page, 'm2-real-claude-reattached')
    c.check('same session id', (await lib.nodeOf(app.page, 'c')).sessionId === node.sessionId)
    await lib.submit(app.page, 'c', 'Now reply with exactly the word MANGO and nothing else. Use no tools.')
    await waitFor('the second turn to start', async () => (await statuses(app.page)).c === 'working', 60000)
    await waitFor('the second turn to finish, in the same process', async () => (await statuses(app.page)).c === 'idle', 120000)
    c.check('it takes a new prompt, and its status comes back from a real hook', true)
    c.check('clean quit exits 0', (await app.quit()) === 0)
  })
}

async function main() {
  const c = checker()
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',')
  const parts = { survives, status, otherVersion, fallback, orphan, dataGone, hostLost, profiles, noisy }
  for (const [name, part] of Object.entries(parts)) {
    if (!only || only.includes(name)) await part(c)
  }
  if (realClaude) await real(c)
  c.finish()
  // Nothing here should keep the process alive, but a stuck handle must not hide the result.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
