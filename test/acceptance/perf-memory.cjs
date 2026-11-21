'use strict'
// Where Patchbay's own memory goes with many sessions. Several project tabs, each with busy agents (claude-load.cjs
// standing in for Claude, so no quota is spent) and a terminal that has printed far more than its scrollback holds.
// Reports private memory by process role, the main process's and the window's JavaScript heaps, and what the windows
// in the shown tab cost (the difference when an empty tab is shown instead). Numbers only: it checks nothing but errors.
//
// Run after a build: node test/acceptance/perf-memory.cjs
//   PB_TABS (default 4)  PB_AGENTS busy agents in each (default 2)  PB_PERF_S seconds of output (default 60)
//   PB_SCROLLBACK lines each window keeps (default: the app's own)  PB_PERF_OUT write the numbers as JSON there
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(15 * 60_000)
const TABS = Number(process.env.PB_TABS || 4)
const AGENTS = Number(process.env.PB_AGENTS || 2)
const SECONDS = Number(process.env.PB_PERF_S || 60)
const LOAD = path.join(__dirname, 'claude-load.cjs').replace(/\\/g, '/')
const MB = (n) => Math.round((n / 1048576) * 10) / 10

/** Private memory of this run's processes, by role. */
function processMemory(profile) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { '{0}|{1}|{2}' -f $_.PrivatePageCount, $_.Name, $_.CommandLine }`
  let text = ''
  try {
    text = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  } catch {
    return {}
  }
  const memory = {}
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [priv, name, cmd] = line.split('|')
    const ours = /^(electron|patchbay)\.exe$/i.test(name)
    const role = !ours ? (/claude-load/.test(cmd) ? 'agents' : 'other') : (/--type=([\w-]+)/.exec(cmd)?.[1] ?? (/hostLauncher|sessionHost|hostProcess|--session-host/i.test(cmd) ? 'host' : 'main'))
    memory[role] = MB((memory[role] ?? 0) * 1048576 + Number(priv))
  }
  return memory
}

/** Evaluates in the main process through its inspector. */
async function mainEval(port, expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const call = (id, method, params) =>
    new Promise((resolve) => {
      ws.addEventListener('message', function on(e) {
        const m = JSON.parse(e.data)
        if (m.id !== id) return
        ws.removeEventListener('message', on)
        resolve(m.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    await call(1, 'HeapProfiler.collectGarbage', {})
    const heap = await call(2, 'Runtime.getHeapUsage', {})
    const r = await call(3, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return { heapUsed: heap?.usedSize ?? null, value: r?.result?.value }
  } finally {
    ws.close()
  }
}

async function windowHeap(page) {
  const cdp = await page.createCDPSession()
  await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  await cdp.detach()
  return usedSize
}

async function measure(label, page, profile, inspect) {
  const main = await mainEval(inspect, 'JSON.stringify(process.memoryUsage())').catch((e) => ({ error: String(e) }))
  const usage = main.value ? JSON.parse(main.value) : {}
  const out = {
    label,
    processesMB: processMemory(profile),
    mainHeapMB: main.heapUsed ? MB(main.heapUsed) : null,
    mainRssMB: usage.rss ? MB(usage.rss) : null,
    mainExternalMB: usage.external ? MB(usage.external) : null,
    windowHeapMB: MB(await windowHeap(page)),
    xtermRows: await page.evaluate(() => document.querySelectorAll('.xterm').length)
  }
  console.log(label, JSON.stringify(out))
  return out
}

async function main() {
  const cwd = L.workDir('perf-memory')
  const settings = { notifications: 'off', sound: 'off', claudeCommand: `node "${LOAD}"` }
  const profile = L.newProfile(settings)
  const inspect = 9500 + Math.floor(Math.random() * 400)
  process.env.PB_MAIN_INSPECT = String(inspect)
  const app = await L.launch({ profile })
  const { page } = app
  const results = []
  try {
    if (process.env.PB_SCROLLBACK) {
      await page.evaluate((n) => {
        const prefs = JSON.parse(localStorage.getItem('patchbay.prefs') ?? '{}')
        localStorage.setItem('patchbay.prefs', JSON.stringify({ ...prefs, terminal: { ...(prefs.terminal ?? {}), scrollback: n } }))
      }, Number(process.env.PB_SCROLLBACK))
      await page.reload()
      await page.waitForSelector('.react-flow', { timeout: 20000 })
    }
    const first = (await L.doc(page)).activeProjectId
    const tabs = []
    for (let t = 0; t < TABS; t++) {
      const projectId = t === 0 ? first : `tab${t}`
      if (t > 0) await page.evaluate((p) => window.patchbay.dispatch({ op: 'addProject', project: p }), { id: projectId, name: `Tab ${t + 1}`, folder: cwd, viewport: { x: 0, y: 0, zoom: 0.5 } })
      const agents = Array.from({ length: AGENTS }, (_, i) => `t${t}a${i}`)
      for (const [i, id] of agents.entries()) await L.openNode(page, { ...L.claude(id, cwd, (i % 2) * 640, Math.floor(i / 2) * 440), width: 620, height: 420, prompt: `${SECONDS + 120} heavy` })
      const term = `t${t}term`
      await L.openNode(page, { ...L.terminal(term, cwd, 1300, 0), width: 760, height: 420 })
      tabs.push({ projectId, agents, term })
    }
    await L.waitFor('the terminals', async () => (await Promise.all(tabs.map((t) => L.snapshot(page, t.term)))).every((s) => s.includes('$')), 60000)
    await page.evaluate((id) => window.patchbay.dispatch({ op: 'switchProject', id }), tabs[0].projectId)
    // Far more lines than any scrollback keeps, in every terminal.
    for (const t of tabs) await L.submit(page, t.term, 'seq -f "line %g of output that a build or a test run might print, long enough to wrap now and then" 1 60000')
    results.push(await measure('START', page, profile, inspect))
    await L.sleep(SECONDS * 1000)
    results.push(await measure('BUSY, ONE TAB SHOWN', page, profile, inspect))
    const empty = 'empty'
    await page.evaluate((p) => window.patchbay.dispatch({ op: 'addProject', project: p }), { id: empty, name: 'Empty', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } })
    await page.evaluate((id) => window.patchbay.dispatch({ op: 'switchProject', id }), empty)
    await L.sleep(3000)
    results.push(await measure('EMPTY TAB SHOWN', page, profile, inspect))
    const shown = results[1].windowHeapMB - results[2].windowHeapMB
    console.log(`WINDOWS IN THE SHOWN TAB (${AGENTS + 1}) cost about ${Math.round(shown)} MB of window heap, ${Math.round(shown / (AGENTS + 1))} MB each`)
    if (process.env.PB_PERF_OUT) fs.writeFileSync(process.env.PB_PERF_OUT, JSON.stringify({ TABS, AGENTS, SECONDS, results }, null, 2))
    c.check('No errors in the page', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
