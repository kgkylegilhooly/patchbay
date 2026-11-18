'use strict'
// Many project tabs, each with several agents working hard and a terminal, as a busy day with Patchbay looks. Measures
// what the agents in the tabs you're not looking at cost, how fast a key shows in the tab you are, and how quickly each
// tab is up to date when you switch to it. The agents are claude-load.cjs standing in for Claude, so no quota is spent.
//
// Run after npm run build: node test/acceptance/perf-tabs.cjs
//   PB_TABS      tabs (default 4)      PB_AGENTS  busy agents in each (default 4)
//   PB_PERF_S    seconds measured (default 25)
//   PB_PERF_REPORT  only report the numbers
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(15 * 60_000)
const TABS = Number(process.env.PB_TABS || 4)
const AGENTS = Number(process.env.PB_AGENTS || 4)
const SECONDS = Number(process.env.PB_PERF_S || 25)
const LOAD = path.join(__dirname, 'claude-load.cjs').replace(/\\/g, '/')

/** CPU seconds and memory of this run's processes, by role. */
function processStats(profile) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.KernelModeTime, $_.UserModeTime, $_.PrivatePageCount, $_.Name, $_.CommandLine }`
  let text = ''
  try {
    text = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  } catch {
    return { cpu: {}, memory: {} }
  }
  const cpu = {}
  const memory = {}
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [kernel, user, priv, name, cmd] = line.split('|')
    const ours = /^(electron|patchbay)\.exe$/i.test(name)
    const role = !ours ? 'agents' : (/--type=([\w-]+)/.exec(cmd)?.[1] ?? (/hostLauncher|sessionHost|hostProcess/i.test(cmd) ? 'host' : 'main'))
    cpu[role] = (cpu[role] ?? 0) + (Number(kernel) + Number(user)) / 1e7
    memory[role] = Math.round((memory[role] ?? 0) + Number(priv) / 1048576)
  }
  return { cpu, memory }
}
const percent = (a, b, seconds) => Object.fromEntries(Object.keys(b).map((k) => [k, Math.round((((b[k] ?? 0) - (a[k] ?? 0)) / seconds) * 100)]))
function machine() {
  let busy = 0
  let all = 0
  for (const { times: t } of os.cpus()) {
    const total = t.user + t.nice + t.sys + t.irq + t.idle
    all += total
    busy += total - t.idle
  }
  return { busy, all }
}

/** From a key being pressed to it showing, read from what's drawn. */
async function keyLatency(page, id, token) {
  const shown = page.evaluate(
    (i, tok) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const check = () => {
          const text = document.querySelector(`.react-flow__node[data-id="${i}"] .xterm-rows`)?.textContent ?? ''
          if (text.includes(tok)) resolve(Math.round(performance.now() - t0))
          else if (performance.now() - t0 > 15000) resolve(15000)
          else requestAnimationFrame(check)
        }
        check()
      }),
    id,
    token
  )
  await page.keyboard.type(token)
  return shown
}

async function main() {
  const cwd = L.workDir('perf-tabs')
  const profile = L.newProfile({ notifications: 'off', sound: 'off', claudeCommand: `node "${LOAD}"` })
  const app = await L.launch({ profile })
  const { page } = app
  const tabs = []
  try {
    const first = (await L.doc(page)).activeProjectId
    for (let t = 0; t < TABS; t++) {
      const projectId = t === 0 ? first : `tab${t}`
      if (t > 0) await page.evaluate((p) => window.patchbay.dispatch({ op: 'addProject', project: p }), { id: projectId, name: `Tab ${t + 1}`, folder: cwd, viewport: { x: 0, y: 0, zoom: 0.6 } })
      const agents = Array.from({ length: AGENTS }, (_, i) => `t${t}a${i}`)
      for (const [i, id] of agents.entries()) await L.openNode(page, { ...L.claude(id, cwd, (i % 2) * 640, Math.floor(i / 2) * 440), width: 620, height: 420, prompt: `${SECONDS * 3 + 120} heavy` })
      const term = `t${t}term`
      await L.openNode(page, L.terminal(term, cwd, 1300, 0))
      tabs.push({ projectId, agents, term })
    }
    await L.waitFor('every agent working', async () => {
      const shown = await Promise.all(tabs.flatMap((t) => t.agents).map((id) => L.snapshot(page, id)))
      return shown.every((s) => s.includes('Working…'))
    }, 90000)
    await L.waitFor('the terminals', async () => (await Promise.all(tabs.map((t) => L.snapshot(page, t.term)))).every((s) => s.includes('$')), 60000)

    // Looking at the first tab while every tab works.
    await page.evaluate((id) => window.patchbay.dispatch({ op: 'switchProject', id }), tabs[0].projectId)
    await L.sleep(1500)
    await L.fitView(page)
    await L.sleep(1500)
    // Which sessions' output reaches the window while one tab shows: only that tab's should.
    const reaching = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ids = new Set()
          const off = window.patchbay.onOutput((id) => ids.add(id))
          setTimeout(() => (off(), resolve([...ids].sort())), 3000)
        })
    )
    const shownIds = [...tabs[0].agents, tabs[0].term]
    console.log('OUTPUT REACHING THE WINDOW', JSON.stringify(reaching))
    c.check("Only the shown tab's output reaches the window", reaching.every((id) => shownIds.includes(id)), reaching)
    await page.click(`.react-flow__node[data-id="${tabs[0].term}"] .xterm-screen`)
    const s0 = processStats(profile)
    const m0 = machine()
    const t0 = Date.now()
    const keys = []
    let k = 0
    while (Date.now() - t0 < SECONDS * 1000) {
      keys.push(await keyLatency(page, tabs[0].term, `k${k++}x`))
      if (k % 5 === 0) await page.keyboard.down('Control').then(() => page.keyboard.press('u')).then(() => page.keyboard.up('Control'))
      await L.sleep(400)
    }
    const seconds = (Date.now() - t0) / 1000
    const s1 = processStats(profile)
    const m1 = machine()
    const cpu = percent(s0.cpu, s1.cpu, seconds)
    const sorted = [...keys].sort((a, b) => a - b)
    const keyStats = { p50: sorted[Math.floor(sorted.length / 2)], worst: sorted.at(-1) }
    console.log('TABS', TABS, 'x', AGENTS, 'busy agents, looking at one tab, for', Math.round(seconds), 's')
    console.log('CPU % of one core', JSON.stringify(cpu))
    console.log('PC busy %', Math.round(((m1.busy - m0.busy) / (m1.all - m0.all)) * 100))
    console.log('MEMORY MB', JSON.stringify(s1.memory))
    console.log('KEYS ms', JSON.stringify(keyStats))

    // Going to each tab in turn: how long until every window in it shows its newest output.
    const switches = []
    for (const tab of [...tabs.slice(1), tabs[0]]) {
      await page.evaluate(() => {
        const w = (window.__gap = { worst: 0, stop: false })
        let last = performance.now()
        const tick = (now) => {
          w.worst = Math.max(w.worst, now - last)
          last = now
          if (!w.stop) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const t = Date.now()
      await page.evaluate((id) => window.patchbay.dispatch({ op: 'switchProject', id }), tab.projectId)
      const ready = await L.waitFor(
        'the tab to show',
        async () => (await page.evaluate((ids) => ids.every((id) => /Working… \(\d+s/.test(document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-rows`)?.textContent ?? '')), tab.agents)) ? Date.now() - t : null,
        20000,
        50
      ).catch(() => -1)
      await L.sleep(800)
      const gap = Math.round(await page.evaluate(() => ((window.__gap.stop = true), window.__gap.worst)))
      switches.push({ tab: tab.projectId, readyMs: ready, worstGap: gap })
    }
    console.log('SWITCHES', JSON.stringify(switches))
    if (process.env.PB_PERF_OUT) fs.writeFileSync(process.env.PB_PERF_OUT, JSON.stringify({ TABS, AGENTS, cpu, keyStats, switches, memory: s1.memory }, null, 2))

    if (!process.env.PB_PERF_REPORT) {
      c.check('A key shows within 150 ms, most of the time, with every tab busy', keyStats.p50 <= 150, keyStats)
      c.check('Every tab is up to date within 2 s of switching to it', switches.every((s) => s.readyMs >= 0 && s.readyMs < 2000), switches)
      c.check('Switching tabs never stops the window drawing for over a second', switches.every((s) => s.worstGap < 1000), switches)
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
