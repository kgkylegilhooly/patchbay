'use strict'
// Shared helpers for the acceptance runs. These drive the real app through its debugging port, with a
// throwaway profile, so real app data is never touched. Only processes started here are ever stopped.
const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { createServer } = require('node:net')
const os = require('node:os')
const path = require('node:path')
const puppeteer = require('puppeteer-core')

const root = path.resolve(__dirname, '..', '..')
const workRoot = path.join(root, '.superpowers', 'accept')
const evidenceDir = path.join(root, 'docs', 'acceptance')
// PATCHBAY_PACKAGED points at another unpacked build, so a check can run while the owner's copy in release/ is open.
const packagedExe = process.env.PATCHBAY_PACKAGED || path.join(root, 'release', 'win-unpacked', 'Patchbay.exe')
/**
 * Prefixes of variables these runs keep from the app: the envNotPassed setting from the person's own Patchbay settings,
 * so a run started inside another app doesn't pass that app's identity on.
 */
function notPassed() {
  try {
    const file = path.join(process.env.APPDATA || '', 'patchbay', 'settings.json')
    const text = JSON.parse(fs.readFileSync(file, 'utf8')).envNotPassed
    return String(text || '').split(/[s,;]+/).filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p)).map((p) => p.toUpperCase())
  } catch {
    return []
  }
}

/** True for a variable a run must not pass to the app or to git: a parent session's, or one named in envNotPassed. */
function inheritNot(key) {
  return /^(CLAUDE_CODE_|PATCHBAY_)|^CLAUDECODE$/i.test(key) || notPassed().some((p) => key.toUpperCase().startsWith(p))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Apps this run started, by profile, so a run that failed partway can end what it began and nothing else. */
const started = new Map()

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

function newProfile(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-accept-'))
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings))
  return dir
}

function workDir(name) {
  const dir = path.join(workRoot, name)
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function waitFor(what, fn, timeoutMs = 60000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e
    }
    await sleep(everyMs)
  }
  throw new Error(`Timed out waiting for ${what}. Last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

/** Made-up agent accounts and Codex limits, for the usage pill. See src/main/usage/agentUsageFixture.ts. */
const MADE_UP_USAGE = {
  claudeAccount: { email: 'you@example.invalid', plan: 'max' },
  codex: {
    account: { email: 'you@example.invalid', plan: 'plus' },
    windows: [
      { percent: 23, minutes: 300, resetsInMinutes: 134 },
      { percent: 41, minutes: 10080, resetsInMinutes: 4 * 24 * 60 }
    ]
  }
}

/**
 * A home folder of the run's own, inside its throwaway profile, so the app never reads the person's ~/.claude (status
 * line, http hook policy, plans), ~/.codex, ~/.ssh or their programs' sign-ins, and the usage pill shows made-up numbers.
 */
function isolatedHome(profile) {
  const home = path.join(profile, 'home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  // Git still needs a name for the commits some runs make.
  const gitconfig = path.join(home, '.gitconfig')
  if (!fs.existsSync(gitconfig)) fs.writeFileSync(gitconfig, '[user]\n\tname = Patchbay Test\n\temail = test@example.invalid\n')
  // Git Bash's prompt named the person and their PC in every picture of a terminal. Git for Windows reads this file in
  // place of its own prompt when it's there.
  const prompt = path.join(home, '.config', 'git', 'git-prompt.sh')
  fs.mkdirSync(path.dirname(prompt), { recursive: true })
  if (!fs.existsSync(prompt)) fs.writeFileSync(prompt, "PS1='\\[\\033[32m\\]you@patchbay \\[\\033[33m\\]\\w\\[\\033[0m\\]\\n$ '\n")
  const usage = path.join(profile, 'agent-usage.json')
  if (!fs.existsSync(usage)) fs.writeFileSync(usage, JSON.stringify(MADE_UP_USAGE))
  return {
    USERPROFILE: home,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    PATCHBAY_SSH_CONFIG: path.join(home, '.ssh', 'config'),
    PATCHBAY_AGENT_USAGE: usage,
    // A packaged build copies its host here: not into the person's own %LOCALAPPDATA%\Patchbay.
    PATCHBAY_HOST_RUNTIME_DIR: path.join(profile, 'host-runtime')
  }
}

/**
 * The app's environment for a run. `realHome` is for the runs that use real agents and their sign-ins (the `*-real`
 * ones, codex.cjs, usage-agents.cjs and those with a real Claude); every other run gets a home of its own. A script's own
 * variables win.
 */
function appEnv({ profile, env: extraEnv, realHome = false, base = process.env }) {
  const env = { ...base, ANTHROPIC_MODEL: 'claude-haiku-5-5' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  // These runs may start from inside another agent's session, which the app must not think it belongs to. Only what's
  // inherited is cleaned: a script's own settings, such as PATCHBAY_HOST_PROTOCOL, go on afterward.
  for (const key of Object.keys(env)) if (inheritNot(key)) delete env[key]
  // The window opens beside the screens without taking focus, so runs don't pop up over whatever else is open.
  // PB_SHOW=1 shows it as usual, to watch a run.
  if (!base.PB_SHOW) env.PATCHBAY_QUIET_WINDOW = '1'
  if (!realHome) {
    // Windows spells some of these in other cases; one spelling each, so the app can't pick up the real one.
    for (const key of Object.keys(env)) if (/^(USERPROFILE|HOME|CLAUDE_CONFIG_DIR|CODEX_HOME)$/i.test(key)) delete env[key]
    Object.assign(env, isolatedHome(profile))
  }
  Object.assign(env, extraEnv)
  return env
}

/** Starts the app and connects. `exe` selects the packaged build; otherwise it runs the built dev output. */
async function launch({ profile, exe, env: extraEnv, realHome }) {
  const port = await freePort()
  const env = appEnv({ profile, env: extraEnv, realHome })
  const file = exe ?? require('electron')
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    // The window can sit behind others on this desktop. Chromium then draws no frames and never
    // acknowledges input, which says nothing about the app, so this run turns that detection off.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ]
  // PB_MAIN_INSPECT=<port> opens the main process to a debugger there, for profiling it.
  if (process.env.PB_MAIN_INSPECT) args.push(`--inspect=${process.env.PB_MAIN_INSPECT}`)
  // PB_REAL_BACKGROUND=1 keeps Chromium's own handling of a hidden window, to measure what hiding it really costs.
  if (process.env.PB_REAL_BACKGROUND) args.splice(2, args.length - 2, ...args.slice(2).filter((a) => !/occlusion|backgrounding|Occlusion/i.test(a)))
  if (!exe) args.push(root)
  const child = spawn(file, args, { cwd: root, env, stdio: 'ignore' })
  const exited = new Promise((r) => child.on('exit', (code) => r(code ?? -1)))
  started.set(profile, child)

  const deadline = Date.now() + 40000
  let browser
  for (;;) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
      break
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`Could not connect: ${e.message}`)
      await sleep(250)
    }
  }
  const page = await waitFor('the app window', async () => {
    const pages = await browser.pages()
    return pages.find((p) => p.url() !== 'about:blank' && !p.url().startsWith('devtools://'))
  })
  // Menus and rename fields close when the window loses focus, as they should. These runs share a desktop with
  // someone using it, so a click elsewhere mustn't count against them.
  const cdp = await page.createCDPSession()
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const problems = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  await page.waitForSelector('.react-flow', { timeout: 20000 })
  await page.evaluate(() => {
    window.__seen = {}
    window.patchbay.onStatus((id, s) => {
      ;(window.__seen[id] ??= []).push(s)
    })
  })

  const app = {
    cdp,
    child,
    page,
    browser,
    profile,
    problems,
    exited,
    /** Ends every session and the host, by the same route as File > Stop all sessions and quit. */
    async quit(timeoutMs = 20000) {
      await page.evaluate(() => window.patchbay.stopAllAndQuit()).catch(() => {})
      const code = await Promise.race([exited, sleep(timeoutMs).then(() => 'timeout')])
      browser.disconnect()
      if (code === 'timeout') throw new Error('The app did not quit')
      return code
    },
    /** Leaves sessions running, by the same route as File > Quit. Closing the window only hides it while sessions run. */
    async quitLeavingSessions(timeoutMs = 20000) {
      const asked = Date.now()
      await page.evaluate(() => window.patchbay.quitApp()).catch(() => {})
      const code = await Promise.race([exited, sleep(timeoutMs).then(() => 'timeout')])
      // The exit guard ends a stuck exit by force, about 4 s on. That isn't this run's failure, but it should be seen.
      if (code === 1 && Date.now() - asked >= 3500) {
        console.log('NOTE  Electron hung on exit, and the exit guard ended it')
        browser.disconnect()
        return 0
      }
      if (code === 'timeout') {
        const state = await Promise.race([page.evaluate(() => Promise.all([window.patchbay.getHostInfo(), window.patchbay.getStatuses()])), sleep(3000).then(() => 'no answer')]).catch((e) => e.message)
        browser.disconnect()
        throw new Error(`The app did not quit. It reports: ${JSON.stringify(state)}`)
      }
      browser.disconnect()
      return code
    },
    /** Force-kills only the process tree started here. */
    async forceKill() {
      browser.disconnect()
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
      await Promise.race([exited, sleep(15000)])
    }
  }
  return app
}

const doc = (page) => page.evaluate(() => window.patchbay.getDoc())
const statuses = (page) => page.evaluate(() => window.patchbay.getStatuses())
const statusOf = async (page, id) => (await statuses(page))[id]
const seenStatuses = (page, id) => page.evaluate((i) => window.__seen[i] ?? [], id)
const snapshot = (page, id) => page.evaluate((i) => window.patchbay.attach(i).then((s) => s.data), id)
const approvals = (page, id) =>
  page.evaluate((i) => window.patchbay.getApprovals().then((a) => a.filter((x) => x.nodeId === i)), id)

/** Opens a node the way the toolbar does: add it, then start it. */
async function openNode(page, node) {
  await page.evaluate(async (n) => {
    await window.patchbay.dispatch({ op: 'addNode', node: n })
    if (n.kind === 'terminal' || n.kind === 'claude' || n.kind === 'run') await window.patchbay.startNode(n.id)
  }, node)
  return node.id
}

const terminal = (id, cwd, x, y, extra = {}) => ({
  id, kind: 'terminal', title: id, x, y, width: 480, height: 300, parentId: null, cwd, ...extra
})
const claude = (id, cwd, x, y, extra = {}) => ({
  id, kind: 'claude', title: id, x, y, width: 620, height: 420, parentId: null, cwd,
  sessionId: null, transcriptPath: null, after: [], ...extra
})

/** What the node's terminal shows now, one string per row, as a person would read it. */
const screen = (page, id) =>
  page.evaluate(
    (i) => [...document.querySelectorAll(`.react-flow__node[data-id="${i}"] .xterm-rows > div`)].map((r) => r.textContent.replace(/\u00a0/g, ' ').trimEnd()),
    id
  )

/** Clicks the dock's Fit view, so a real mouse click can reach every node. */
async function fitView(page) {
  await page.evaluate(() => [...document.querySelectorAll('[data-cmd="fit-view"]')].find((b) => b.closest('.dock')).click())
  await sleep(500)
}

const input = (page, id, data) => page.evaluate((i, d) => window.patchbay.input(i, d), id, data)

/** Types and submits, with Enter separate, since Claude reads one chunk as a paste. */
async function submit(page, id, text) {
  await input(page, id, text)
  await sleep(300)
  await input(page, id, '\r')
}

async function nodeOf(page, id) {
  return (await doc(page)).nodes.find((n) => n.id === id)
}

/** The conversation as written by Claude, read straight from its transcript. */
function transcriptText(file) {
  if (!file || !fs.existsSync(file)) return ''
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'user' && e.type !== 'assistant') continue
      const c = e.message?.content
      if (typeof c === 'string') out.push(`${e.type}: ${c}`)
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text') out.push(`${e.type}: ${b.text}`)
          else if (b.type === 'tool_use') out.push(`${e.type} used ${b.name}: ${JSON.stringify(b.input)}`)
          else if (b.type === 'tool_result') out.push(`tool result: ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`)
        }
      }
    } catch {
      // A session still writing leaves a partial final line.
    }
  }
  return out.join('\n')
}

function settingsHash() {
  const file = path.join(os.homedir(), '.claude', 'settings.json')
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function shot(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true })
  const file = path.join(evidenceDir, `${name}.png`)
  await page.screenshot({ path: file })
  return path.relative(root, file).replace(/\\/g, '/')
}

/** Tracks named checks and prints a result line for each. */
function checker() {
  const results = []
  return {
    results,
    check(name, ok, detail) {
      results.push({ name, ok: !!ok })
      const extra = detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra}`)
    },
    finish() {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${results.length - failed.length} of ${results.length} checks passed`)
      process.exitCode = failed.length ? 1 : 0
    }
  }
}

/** The session host of a throwaway profile, if one is running. */
function hostPid(profile) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(profile, 'control', 'host.json'), 'utf8'))
    return alive(pid) ? pid : null
  } catch {
    return null
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}

/** A run that stopped partway can leave its own host behind. Only a host belonging to this throwaway profile is ended. */
function stopHostOf(profile) {
  const pid = hostPid(profile)
  if (pid) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
}

function cleanup(profile) {
  const child = started.get(profile)
  if (child && child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 })
  started.delete(profile)
  stopHostOf(profile)
  // A folder still held open shouldn't end the whole run and hide every result after it, but it should be seen.
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (e) {
    console.log(`NOTE  could not remove ${profile}: ${e.code ?? e.message}`)
  }
}

module.exports = {
  inheritNot, appEnv, isolatedHome,
  root, workRoot, packagedExe, sleep, newProfile, workDir, waitFor, launch, doc, statuses, statusOf, seenStatuses,
  hostPid, alive, stopHostOf, snapshot, screen, fitView, approvals, openNode, terminal, claude, input, submit, nodeOf, transcriptText, settingsHash, shot, checker, cleanup
}
