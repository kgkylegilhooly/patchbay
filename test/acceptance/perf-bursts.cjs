'use strict'
// The moments when every window has a lot to do at once, which is where a busy canvas could freeze for seconds:
//   1. every agent reprints its whole conversation at once, as Claude Code does after a resize
//   2. every window is resized at once, so each terminal reflows thousands of lines of history
//   3. the project is left and come back to, so each terminal is rebuilt from its saved output
// For each, this measures the longest the window went without drawing a frame, and how long until all was done.
// Run after npm run build: node test/acceptance/perf-bursts.cjs [--packaged]
//   PB_PERF_N  windows (default 10)    PB_BURST_KB  how much each prints (default 600)
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(10 * 60_000)
const N = Number(process.env.PB_PERF_N || 10)
const KB = Number(process.env.PB_BURST_KB || 600)
const BURST = path.join(__dirname, 'burst.cjs').replace(/\\/g, '/')

const watch = (page) =>
  page.evaluate(() => {
    const w = (window.__perf = { gaps: [], long: [], stop: false, started: performance.now() })
    let last = performance.now()
    const tick = (now) => {
      w.gaps.push(now - last)
      last = now
      if (!w.stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    w.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.long.push(e.duration)
    })
    w.observer.observe({ entryTypes: ['longtask'] })
  })

const stop = (page) =>
  page.evaluate(() => {
    const w = window.__perf
    w.stop = true
    w.observer.disconnect()
    return { worstFrameGap: Math.round(Math.max(...w.gaps)), longTasks: w.long.length, worstLongTask: Math.round(Math.max(0, ...w.long)), longTaskMs: Math.round(w.long.reduce((a, b) => a + b, 0)) }
  })

/** How long until every window shows the text, read from what's drawn on screen. */
const allShow = (page, ids, text, timeoutMs = 60000) =>
  page.evaluate(
    (all, t, limit) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const check = () => {
          const done = all.every((id) => document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-rows`)?.textContent.includes(t))
          if (done) resolve(Math.round(performance.now() - t0))
          else if (performance.now() - t0 > limit) resolve(-1)
          else setTimeout(check, 50)
        }
        check()
      }),
    ids,
    text,
    timeoutMs
  )

async function measure(page, name, act, ids, text) {
  await watch(page)
  const t0 = Date.now()
  await act()
  const shown = text ? await allShow(page, ids, text) : 0
  const total = Date.now() - t0
  await L.sleep(500)
  const frames = await stop(page)
  const result = { name, allDoneMs: shown < 0 ? 'never' : total, ...frames }
  console.log('BURST', JSON.stringify(result))
  return result
}

async function main() {
  const cwd = L.workDir('perf-bursts')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  const { page } = app
  const ids = Array.from({ length: N }, (_, i) => `w${i}`)
  try {
    const cols = Math.ceil(Math.sqrt(N))
    for (const [i, id] of ids.entries()) await L.openNode(page, L.terminal(id, cwd, (i % cols) * 500, Math.floor(i / cols) * 320))
    await L.waitFor('the shells', async () => (await Promise.all(ids.map((id) => L.snapshot(page, id)))).every((s) => s.includes('$')), 60000)
    await L.fitView(page)
    // History to reflow and replay later: each fills its scrollback first.
    for (const id of ids) await L.submit(page, id, `node "${BURST}" ${KB} fill`)
    await L.waitFor('the fill', async () => (await Promise.all(ids.map((id) => L.snapshot(page, id)))).every((s) => s.includes('BURST-DONE-fill')), 60000)
    await L.sleep(1500)

    const results = []
    results.push(
      await measure(page, 'every window reprints its whole conversation at once', async () => {
        for (const id of ids) await L.input(page, id, `node "${BURST}" ${KB} again --clear\r`)
      }, ids, 'BURST-DONE-again')
    )
    await L.sleep(1000)
    results.push(
      await measure(page, 'every window is resized at once', async () => {
        const doc = await L.doc(page)
        await page.evaluate(async (nodes) => {
          for (const n of nodes) await window.patchbay.dispatch({ op: 'patchNode', id: n.id, patch: { width: n.width - 90 } })
        }, doc.nodes.filter((n) => ids.includes(n.id)))
        await L.sleep(300)
      }, ids, null)
    )
    await L.sleep(1000)
    const home = (await L.doc(page)).activeProjectId
    await page.evaluate((folder) => window.patchbay.dispatch({ op: 'addProject', project: { id: 'other', name: 'Other', folder, viewport: { x: 0, y: 0, zoom: 1 } } }), cwd)
    await L.sleep(1500)
    results.push(
      await measure(page, 'coming back to the project rebuilds every window from its saved output', async () => {
        await page.evaluate((id) => window.patchbay.dispatch({ op: 'switchProject', id }), home)
      }, ids, 'BURST-DONE-again')
    )

    if (!process.env.PB_PERF_REPORT) {
      for (const r of results) {
        c.check(`${r.name}: the window never stops drawing for over a second`, r.worstFrameGap < 1000, r)
        c.check(`${r.name}: it all lands within 10 s`, r.allDoneMs !== 'never' && r.allDoneMs < 10000, r)
      }
    }
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
