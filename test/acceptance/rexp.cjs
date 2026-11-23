'use strict'
// A/B in one launch: the heavy scene from rperf.cjs with output running, measured with one suspect switched off at a
// time (by an injected style, or a pref).
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const R = require('./rperf.cjs')

U.watchdog(30 * 60_000)
const SECS = Number(process.env.PB_RX_S || 4)
const ACTS = (process.env.PB_RX_ACTS || 'output,pan,zoom').split(',')
const out = {}

function cpuByRole(profile) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.KernelModeTime, $_.UserModeTime, $_.Name, $_.CommandLine }`
  const text = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const cpu = {}
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [k, u, name, cmd] = line.split('|')
    if (!/^electron\.exe$/i.test(name)) continue
    const role = /--type=([\w-]+)/.exec(cmd)?.[1] ?? (/sessionHost/.test(cmd) ? 'host' : 'main')
    cpu[role] = (cpu[role] ?? 0) + (Number(k) + Number(u)) / 1e7
  }
  return cpu
}

const VARIANTS = {
  base: null,
  'no-cable-anim': '.cable-flow{animation:none!important}',
  'no-led-anim': '.led{animation:none!important}',
  'no-shadows': '.unit,.note,.wb,.rack,.browser,.react-flow__node>*{box-shadow:none!important}',
  'no-minimap': 'minimap',
  'no-term-paint': '.term-host{visibility:hidden!important}',
  'no-webviews': 'webview{display:none!important}',
  'no-edges': '.react-flow__edges{display:none!important}',
  'viewport-layer': '.react-flow__viewport{will-change:transform}',
  'contain-nodes': '.react-flow__node{contain:layout paint style}'
}

async function toggleMinimap(page) {
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Control')
  await page.waitForSelector('.palette input', { timeout: 3000 })
  await page.keyboard.type('Minimap')
  await L.sleep(200)
  await page.keyboard.press('Enter')
  await L.sleep(500)
}

async function measure(ctx, act) {
  const { page, cdp, profile, spot } = ctx
  const c0 = cpuByRole(profile)
  await R.startFrames(page)
  const m0 = await R.metrics(cdp)
  const t0 = Date.now()
  if (act === 'output') await L.sleep(SECS * 1000)
  if (act === 'pan') await R.pan(page, spot, SECS)
  if (act === 'zoom') await R.wheelZoom(page, spot, SECS)
  const secs = (Date.now() - t0) / 1000
  const m1 = await R.metrics(cdp)
  const f = await R.stopFrames(page)
  const c1 = cpuByRole(profile)
  const cpu = Object.fromEntries(Object.keys(c1).map((k) => [k, Math.round(((c1[k] - (c0[k] ?? 0)) / (secs + 1.2)) * 100)]))
  return { fps: f.fps, p95: f.p95, worst: f.worst, over33: f.over33, busy: R.metricDelta(m0, m1, secs), cpu }
}

async function main() {
  const s = await R.site()
  const cwd = L.workDir('rexp')
  const profile = L.newProfile({ claudeCommand: `node "${R.LOAD}"`, notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(R.canvas(cwd, s.port)))
  const app = await L.launch({ profile })
  const { page } = app
  const cdp = await page.createCDPSession()
  await cdp.send('Performance.enable')
  try {
    if (process.env.PB_RX_SLOW) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PB_RX_SLOW) })
    const termIds = ['typing', ...Array.from({ length: 16 }, (_, i) => `t${i}`)]
    await L.waitFor('the shells', async () => (await Promise.all(termIds.map((id) => L.snapshot(page, id)))).every((x) => x.includes('$')), 90000)
    for (const [i, id] of termIds.slice(1).entries()) await L.submit(page, id, `node "${R.LOAD}" 1500${i % 4 === 3 ? ' --heavy' : ''}`)
    await L.sleep(5000)
    if (process.env.PB_RX_FAR) {
      await L.fitView(page)
      await L.sleep(800)
    }
    const spot = await U.emptySpot(page)
    const ctx = { page, cdp, profile, spot }
    const order = (process.env.PB_RX_VARIANTS || Object.keys(VARIANTS).join(',')).split(',')
    for (const rep of [0, 1]) {
      for (const v of order) {
        const css = VARIANTS[v]
        let tag = null
        if (css === 'minimap') await toggleMinimap(page)
        else if (css) tag = await page.addStyleTag({ content: css })
        await L.sleep(600)
        for (const act of ACTS) {
          const r = await measure(ctx, act)
          ;((out[v] ??= {})[act] ??= []).push(r)
          console.log(rep, v.padEnd(14), act.padEnd(6), JSON.stringify({ fps: r.fps, p95: r.p95, worst: r.worst, task: r.busy['Task%'], script: r.busy['Script%'], style: r.busy['RecalcStyle%'], layout: r.busy['Layout%'], cpu: r.cpu }))
        }
        if (css === 'minimap') await toggleMinimap(page)
        else if (tag) await tag.evaluate((t) => t.remove())
      }
    }
  } finally {
    fs.writeFileSync(process.env.PB_RX_OUT || path.join(__dirname, 'rexp.json'), JSON.stringify(out, null, 2))
    await app.quit().catch(() => {})
    L.cleanup(profile)
    s.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
