'use strict'
// Reopening Patchbay on a big canvas, as after an update or a restart: many terminals still running in the background,
// each with a full history to show again. Measures how long until the window answers, and until every terminal
// shows its latest output, and the longest the window goes without drawing on the way.
// Run after npm run build: node test/acceptance/perf-reopen.cjs   (PB_PERF_N terminals, default 20)
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(10 * 60_000)
const N = Number(process.env.PB_PERF_N || 20)
const BURST = path.join(__dirname, 'burst.cjs').replace(/\\/g, '/')

async function main() {
  const cwd = L.workDir('perf-reopen')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  let app = await L.launch({ profile })
  const ids = Array.from({ length: N }, (_, i) => `r${i}`)
  try {
    const cols = Math.ceil(Math.sqrt(N))
    for (const [i, id] of ids.entries()) await L.openNode(app.page, L.terminal(id, cwd, (i % cols) * 500, Math.floor(i / cols) * 320))
    await L.waitFor('the shells', async () => (await Promise.all(ids.map((id) => L.snapshot(app.page, id)))).every((s) => s.includes('$')), 90000)
    for (const id of ids) await L.submit(app.page, id, `node "${BURST}" 1100 full; echo READY-${id}`)
    await L.waitFor('the fill', async () => (await Promise.all(ids.map((id) => L.snapshot(app.page, id)))).every((s, i) => s.includes(`READY-${ids[i]}`)), 120000)
    await L.fitView(app.page)
    await L.sleep(2000)
    await app.quitLeavingSessions()

    const t0 = Date.now()
    app = await L.launch({ profile })
    const windowMs = Date.now() - t0
    const page = app.page
    await page.evaluate(() => {
      const w = (window.__gaps = { worst: 0, stop: false })
      let last = performance.now()
      const tick = (now) => {
        w.worst = Math.max(w.worst, now - last)
        last = now
        if (!w.stop) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const shownMs = await L.waitFor(
      'every terminal to show its latest output',
      async () => {
        const all = await page.evaluate((list) => list.every((id) => document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-rows`)?.textContent.includes(`READY-${id}`)), ids)
        return all ? Date.now() - t0 : null
      },
      60000,
      100
    ).catch(() => -1)
    const answer = Date.now()
    await page.evaluate(() => 1)
    const answerMs = Date.now() - answer
    const worstGap = Math.round(await page.evaluate(() => ((window.__gaps.stop = true), window.__gaps.worst)))
    console.log('REOPEN', JSON.stringify({ terminals: N, windowMs, allShownMs: shownMs, worstGapWhileFilling: worstGap, answerMs }))
    if (!process.env.PB_PERF_REPORT) {
      c.check(`All ${N} terminals show their latest output within 15 s of launch`, shownMs > 0 && shownMs < 15000, shownMs)
      c.check('The window never stops drawing for over a second while they fill', worstGap < 1000, worstGap)
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
