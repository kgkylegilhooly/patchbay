'use strict'
// What busy windows cost while Patchbay is minimized, and how quickly it catches up when it's brought back: the
// window should do next to nothing while nobody can see it, and show everything that happened, promptly, after.
// Chromium's own handling of a hidden window is kept on here, unlike the other runs.
// Run after npm run build: node test/acceptance/perf-hidden.cjs   (PB_PERF_N windows, PB_HIDDEN_S seconds hidden)
process.env.PB_REAL_BACKGROUND = '1'
const path = require('node:path')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(10 * 60_000)
const N = Number(process.env.PB_PERF_N || 10)
const HIDDEN_S = Number(process.env.PB_HIDDEN_S || 30)
const LOAD = path.join(__dirname, 'claude-load.cjs').replace(/\\/g, '/')

function rendererSeconds(profile) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' -and $_.CommandLine -like '*--type=renderer*' } | ForEach-Object { $_.KernelModeTime + $_.UserModeTime }`
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((a, b) => a + Number(b) / 1e7, 0)
  } catch {
    return 0
  }
}

/** Hides it as a person does with sessions running: closing it sends it to the tray. */
const hide = (app) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${app.child.pid}).CloseMainWindow()`], { stdio: 'ignore' })
/** Brings it back as the tray icon or a second launch does. */
const show = (profile) => {
  const env = { ...process.env, PATCHBAY_QUIET_WINDOW: '1', PATCHBAY_TEST_DIALOGS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  spawn(require('electron'), [`--user-data-dir=${profile}`, L.root], { cwd: L.root, env, stdio: 'ignore' })
}

async function main() {
  const cwd = L.workDir('perf-hidden')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile })
  const { page } = app
  // Whether the window is really hidden is the point here, which focus emulation would mask.
  await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  const ids = Array.from({ length: N }, (_, i) => `h${i}`)
  try {
    const cols = Math.ceil(Math.sqrt(N))
    for (const [i, id] of ids.entries()) await L.openNode(page, L.terminal(id, cwd, (i % cols) * 500, Math.floor(i / cols) * 320))
    await L.waitFor('the shells', async () => (await Promise.all(ids.map((id) => L.snapshot(page, id)))).every((s) => s.includes('$')), 60000)
    await L.fitView(page)
    for (const id of ids) await L.submit(page, id, `node "${LOAD}" ${HIDDEN_S + 30} --heavy`)
    const loadStarted = Date.now()
    await L.sleep(4000)

    const shown0 = rendererSeconds(profile)
    await L.sleep(10000)
    const shownCpu = Math.round(((rendererSeconds(profile) - shown0) / 10) * 100)

    hide(app)
    await L.waitFor('the window to hide', async () => (await page.evaluate(() => document.visibilityState)) === 'hidden', 10000).catch(() => {})
    await L.sleep(2000)
    const hidden = await page.evaluate(() => document.visibilityState)
    const hidden0 = rendererSeconds(profile)
    await L.sleep(HIDDEN_S * 1000)
    const hiddenCpu = Math.round(((rendererSeconds(profile) - hidden0) / HIDDEN_S) * 100)
    const t0 = Date.now()
    show(profile)
    await L.waitFor('the window to come back', async () => (await page.evaluate(() => document.visibilityState)) === 'visible', 15000)
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
    // Every window has to show the newest of its output: its spinner line's count of seconds, near where it is now.
    const due = Math.floor((Date.now() - loadStarted) / 1000) - 4
    const latest = await page.evaluate(
      (all, least) =>
        new Promise((resolve) => {
          const t = performance.now()
          const check = () => {
            const ok = all.every((id) => Number(/Working… \((\d+)s/.exec(document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-rows`)?.textContent ?? '')?.[1] ?? -1) >= least)
            if (ok || performance.now() - t > 20000) resolve(ok ? Math.round(performance.now() - t) : -1)
            else setTimeout(check, 50)
          }
          check()
        }),
      ids,
      due
    )
    await L.sleep(1000)
    const worstGap = Math.round(await page.evaluate(() => ((window.__gaps.stop = true), window.__gaps.worst)))
    console.log('HIDDEN', JSON.stringify({ visibility: hidden, shownCpu, hiddenCpu, catchUpMs: latest, worstGapAfter: worstGap, restoreMs: Date.now() - t0 }))
    if (!process.env.PB_PERF_REPORT) {
      c.check('Minimized, the window really is hidden', hidden === 'hidden', hidden)
      c.check('Hidden, the window uses well under half what it does shown', hiddenCpu < shownCpu / 2, { shownCpu, hiddenCpu })
      c.check('Brought back, every window is up to date within 3 s', latest >= 0 && latest < 3000, latest)
      c.check('Catching up never stops the window drawing for over a second', worstGap < 1000, worstGap)
    }
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
