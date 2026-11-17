'use strict'
// Stress and leak checks on the real app. A few terminals flood output while the window is timed answering, then many
// nodes of every kind are opened and closed, and memory, DOM size and event listeners are compared with where they
// started, after garbage collection. No Claude runs, so it spends no quota.
// Run: node test/acceptance/soak.cjs [--packaged]
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(12 * 60_000)
const FLOOD_S = Number(process.env.PB_FLOOD_S || 20)
const MB = 1024 * 1024

/** Memory of each of this run's processes, by role, from Windows. */
function processMemory(profile) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.PrivatePageCount, $_.CommandLine }`
  let out = ''
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  } catch {
    return {}
  }
  const roles = {}
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [, priv, cmd] = line.split('|')
    const type = /--type=([\w-]+)/.exec(cmd)?.[1] ?? (/hostProcess|host\.js|session-host/i.test(cmd) ? 'host' : 'main')
    roles[type] = (roles[type] ?? 0) + Number(priv) / MB
  }
  return Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, Math.round(v)]))
}

/** The window's own numbers, after a full garbage collection. */
async function windowStats(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const m = await page.metrics()
  return { heapMB: Math.round(m.JSHeapUsedSize / MB), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents }
}

/** How long the window takes to answer, and to draw a frame, right now. */
async function latency(page) {
  const t0 = Date.now()
  await page.evaluate(() => 1)
  const answer = Date.now() - t0
  const t1 = Date.now()
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
  return { answer, frame: Date.now() - t1 }
}

/** How long the main process takes to answer the window. */
const mainLatency = (page) => page.evaluate(async () => {
  const t = performance.now()
  await window.patchbay.getApprovals()
  return Math.round(performance.now() - t)
})

async function main() {
  const cwd = L.workDir('soak')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  const { page } = app
  const cdp = await page.createCDPSession()
  const report = { flood: [], churn: [] }
  try {
    for (const [i, id] of ['f1', 'f2', 'f3', 'quiet'].entries()) await L.openNode(page, L.terminal(id, cwd, (i % 2) * 560, Math.floor(i / 2) * 360))
    await L.waitFor('the shells', async () => (await Promise.all(['f1', 'f2', 'f3', 'quiet'].map((id) => L.snapshot(page, id)))).every((s) => s.includes('$')), 30000)
    await L.sleep(1500)
    const base = { window: await windowStats(page, cdp), processes: processMemory(profile) }
    console.log('BASE', JSON.stringify(base))

    // 1. Floods: long lines as fast as the shell can print them, in three terminals at once.
    const line = 'flood '.repeat(30)
    for (const id of ['f1', 'f2', 'f3']) await L.submit(page, id, `timeout ${FLOOD_S} yes '${line}'; echo FLOOD-DONE`)
    const started = Date.now()
    let worst = { answer: 0, frame: 0, main: 0 }
    let typedAt = null
    while (Date.now() - started < (FLOOD_S + 4) * 1000) {
      const l = await latency(page)
      const m = await mainLatency(page)
      worst = { answer: Math.max(worst.answer, l.answer), frame: Math.max(worst.frame, l.frame), main: Math.max(worst.main, m) }
      report.flood.push({ t: Math.round((Date.now() - started) / 1000), ...l, main: m, mem: processMemory(profile) })
      // Halfway through, the person types in the quiet terminal, as they would: by clicking it and typing.
      if (!typedAt && Date.now() - started > (FLOOD_S / 2) * 1000) {
        await page.click('.react-flow__node[data-id="quiet"] .xterm-screen')
        await page.keyboard.type('echo still-typing')
        await page.keyboard.press('Enter')
        typedAt = Date.now()
      }
      await L.sleep(1000)
    }
    const echoed = await L.waitFor('the quiet terminal', async () => /\nstill-typing/.test(await L.snapshot(page, 'quiet')), 15000).then(() => true, () => false)
    const typed = echoed && typedAt !== null
    for (const s of report.flood) console.log('FLOOD', JSON.stringify(s))
    const done = await L.waitFor('the floods to end', async () => (await Promise.all(['f1', 'f2', 'f3'].map((id) => L.snapshot(page, id)))).every((s) => s.includes('FLOOD-DONE')), 60000).then(() => true, () => false)
    const settledAt = Date.now()
    await L.sleep(3000)
    const afterFlood = { window: await windowStats(page, cdp), processes: processMemory(profile), latency: await latency(page), main: await mainLatency(page) }
    console.log('AFTER-FLOOD', JSON.stringify(afterFlood), 'all done', Math.round((settledAt - started) / 1000), 's after the floods began')
    c.check('The window keeps answering within a second during a flood', worst.answer < 1000, worst)
    c.check('The window keeps drawing frames during a flood', worst.frame < 1000, worst)
    c.check('The main process keeps answering during a flood', worst.main < 1000, worst)
    c.check('A quiet terminal still takes typing during a flood', typed)
    c.check('The floods finish and the window catches up', done)
    const peak = Math.max(...report.flood.map((s) => s.mem.renderer ?? 0))
    c.check('The window does not balloon during a flood (under 600 MB)', peak < 600, { base: base.processes.renderer, peak })
    const peakMain = Math.max(...report.flood.map((s) => s.mem.main ?? 0))
    c.check('The main process does not balloon during a flood (under 400 MB)', peakMain < 400, { base: base.processes.main, peak: peakMain })

    // 2. Churn: open and close nodes of every kind many times, and move between the views.
    const kinds = ['terminal', 'sticky', 'whiteboard', 'browser']
    const once = async (round) => {
      const ids = []
      for (const [i, kind] of kinds.entries()) {
        const id = `churn-${round}-${kind}`
        ids.push(id)
        const at = { x: 1400 + i * 300, y: 900, parentId: null }
        const node =
          kind === 'terminal' ? L.terminal(id, cwd, at.x, at.y)
          : kind === 'sticky' ? { id, kind, title: id, ...at, width: 260, height: 200, text: `note ${round}` }
          : kind === 'whiteboard' ? { id, kind, title: id, ...at, width: 400, height: 300, shapes: [{ type: 'rect', color: '#1f1f22', size: 4, x1: 10, y1: 10, x2: 100, y2: 80 }] }
          : { id, kind, title: id, ...at, width: 480, height: 320, url: 'about:blank' }
        await L.openNode(page, node)
      }
      await L.sleep(600)
      await page.click('.dock [data-cmd="toggle-focus"]').catch(() => {})
      await L.sleep(300)
      await page.click('.dock [data-cmd="toggle-focus"]').catch(() => {})
      await L.sleep(200)
      await page.evaluate((all) => window.patchbay.dispatch({ op: 'removeNodes', ids: all, at: Date.now() }), ids)
      await L.sleep(400)
    }
    for (let round = 0; round < 3; round++) await once(`warm${round}`)
    await L.sleep(2000)
    const warm = { window: await windowStats(page, cdp), processes: processMemory(profile) }
    const ROUNDS = Number(process.env.PB_CHURN || 25)
    for (let round = 0; round < ROUNDS; round++) await once(round)
    await L.sleep(3000)
    const after = { window: await windowStats(page, cdp), processes: processMemory(profile) }
    console.log('CHURN warm', JSON.stringify(warm), '\nCHURN after', ROUNDS, 'rounds', JSON.stringify(after))
    const perRound = (a, b) => Math.round(((a - b) / ROUNDS) * 10) / 10
    c.check('Closed nodes leave no DOM behind', after.window.nodes - warm.window.nodes < 200, { warm: warm.window.nodes, after: after.window.nodes, perRound: perRound(after.window.nodes, warm.window.nodes) })
    c.check('Closed nodes leave no event listeners behind', after.window.listeners - warm.window.listeners < 50, { warm: warm.window.listeners, after: after.window.listeners, perRound: perRound(after.window.listeners, warm.window.listeners) })
    c.check('The window heap does not grow with churn (under 15 MB)', after.window.heapMB - warm.window.heapMB < 15, { warm: warm.window.heapMB, after: after.window.heapMB })
    c.check('Closed browser pages are gone', after.window.documents <= warm.window.documents + 1, { warm: warm.window.documents, after: after.window.documents })
    const mainGrowth = (after.processes.main ?? 0) - (warm.processes.main ?? 0)
    c.check('The main process does not grow with churn (under 60 MB)', mainGrowth < 60, { warm: warm.processes.main, after: after.processes.main })
    c.check('No errors in the page', app.problems.length === 0, app.problems.slice(0, 3))
    if (process.env.PB_SOAK_OUT) fs.writeFileSync(path.join(process.env.PB_SOAK_OUT, 'soak.json'), JSON.stringify({ base, afterFlood, warm, after, report }, null, 2))
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
