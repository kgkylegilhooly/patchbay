'use strict'
// How the app holds up with many agents working hard at once. A dozen terminals each print what Claude Code prints
// while it works (see claude-load.cjs) while a person types in another one, and this measures what they'd feel: how
// long a key takes to show, how long the window goes without drawing, and how much CPU each process uses.
// No Claude runs, so it spends no quota.
//
// Run: node test/acceptance/perf.cjs [--packaged]
//   PB_PERF_N       busy terminals (default 12)
//   PB_PERF_S       seconds measured (default 25)
//   PB_PERF_HEAVY=1 print at the heaviest rate
//   PB_PERF_PROFILE=<file.json> also writes the window's CPU profile summary there
//   PB_PERF_REPORT  only report the numbers, without passing or failing them
//   PB_PERF_KIND=claude  agent windows instead of terminals, each with what Claude runs besides (see claude-load.cjs)
//   PB_PERF_CHAT=1  shows each agent window as a chat
//   PB_LOAD_TRANSCRIPT_MB  how big each agent's conversation starts out
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(10 * 60_000)
const N = Number(process.env.PB_PERF_N || 12)
const SECONDS = Number(process.env.PB_PERF_S || 25)
const HEAVY = process.env.PB_PERF_HEAVY === '1'
const LOAD = path.join(__dirname, 'claude-load.cjs').replace(/\\/g, '/')
const AGENTS = process.env.PB_PERF_KIND === 'claude'
const CHAT = process.env.PB_PERF_CHAT === '1'

/** Busy time of the whole PC so far, across every core: hooks and status lines run outside Patchbay's own processes. */
function machineTimes() {
  let busy = 0
  let all = 0
  for (const { times } of os.cpus()) {
    const total = times.user + times.nice + times.sys + times.irq + times.idle
    all += total
    busy += total - times.idle
  }
  return { busy, all, cores: os.cpus().length }
}
const machinePercent = (a, b) => Math.round(((b.busy - a.busy) / (b.all - a.all)) * 100)

/** CPU seconds by program name across the PC, including programs that have since exited, from Windows' counters. */
function cpuByProgram() {
  const ps = `Get-Process | Group-Object ProcessName | ForEach-Object { '{0}|{1}|{2}' -f $_.Name, ($_.Group | Measure-Object CPU -Sum).Sum, $_.Count }`
  try {
    const text = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    return Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((l) => l.split('|')).map(([name, cpu, count]) => [name, { cpu: Number(cpu) || 0, count: Number(count) }]))
  } catch {
    return {}
  }
}

/** CPU seconds used so far by each of this run's processes, by role. */
function cpuTimes(profile) {
  return processStats(profile).cpu
}

/** CPU seconds and private memory (MB) of each of this run's processes, by role. */
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
    // Agents' own programs name the profile too, in their settings path, so only Patchbay's own executable counts here.
    const ours = /^(electron|patchbay)\.exe$/i.test(name)
    const role = !ours ? 'agents' : (/--type=([\w-]+)/.exec(cmd)?.[1] ?? (/hostLauncher|sessionHost|hostProcess/i.test(cmd) ? 'host' : 'main'))
    cpu[role] = (cpu[role] ?? 0) + (Number(kernel) + Number(user)) / 1e7
    memory[role] = Math.round((memory[role] ?? 0) + Number(priv) / 1024 / 1024)
  }
  return { cpu, memory }
}

const percentOfCore = (before, after, seconds) =>
  Object.fromEntries(Object.keys(after).map((role) => [role, Math.round((((after[role] ?? 0) - (before[role] ?? 0)) / seconds) * 100)]))

/** Watches, in the window, every gap between frames and every task that held it up. */
const startWatching = (page) =>
  page.evaluate(() => {
    const w = (window.__perf = { gaps: [], long: [], stop: false })
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

const stopWatching = (page) =>
  page.evaluate(() => {
    const w = window.__perf
    w.stop = true
    w.observer.disconnect()
    const sorted = [...w.gaps].sort((a, b) => a - b)
    const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0)
    return {
      frames: w.gaps.length,
      frameP50: pct(0.5),
      frameP95: pct(0.95),
      worstFrameGap: Math.round(sorted.at(-1) ?? 0),
      longTasks: w.long.length,
      longTaskMs: Math.round(w.long.reduce((a, b) => a + b, 0)),
      worstLongTask: Math.round(Math.max(0, ...w.long))
    }
  })

/** What a node's terminal shows, read the way a person sees it. */
const shownText = (id) => {
  const rows = document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-rows`)
  return rows?.textContent ?? ''
}

/** From a key being pressed to it showing in the terminal, as the person typing it would see. */
async function keyLatency(page, id, token) {
  const shown = page.evaluate(
    (i, tok, readText) =>
      new Promise((resolve) => {
        const read = new Function(`return (${readText})`)()
        const t0 = performance.now()
        const check = () => {
          if (read(i).includes(tok)) resolve(Math.round(performance.now() - t0))
          else if (performance.now() - t0 > 15000) resolve(15000)
          else requestAnimationFrame(check)
        }
        check()
      }),
    id,
    token,
    shownText.toString()
  )
  await page.keyboard.type(token)
  return shown
}

/** The window's own busy time, from Chromium, split into script, style and layout. */
async function busyMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0
  return { task: get('TaskDuration'), script: get('ScriptDuration'), layout: get('LayoutDuration'), style: get('RecalcStyleDuration') }
}

/** A sampling profile of the main process, through the debugger PB_MAIN_INSPECT opened. */
async function profileMain(port, seconds) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    waiting.get(msg.id)?.(msg.result)
  }
  const send = (method, params = {}) => new Promise((r) => (waiting.set(++id, r), ws.send(JSON.stringify({ id, method, params }))))
  await send('Profiler.enable')
  await send('Profiler.setSamplingInterval', { interval: 500 })
  await send('Profiler.start')
  await L.sleep(seconds * 1000)
  const { profile } = await send('Profiler.stop')
  ws.close()
  return summarizeProfile(profile)
}

/** Where the window's CPU went, by function, from a sampling profile. */
function summarizeProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const total = profile.samples.length
  const counts = new Map()
  for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1)
  for (const [id, n] of counts) {
    const f = byId.get(id).callFrame
    const file = f.url.split('/').pop()?.split('?')[0] || '(native)'
    const key = `${f.functionName || '(anonymous)'}  ${file}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + n)
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, n]) => `${((n / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
}

async function main() {
  const cwd = L.workDir('perf')
  const profile = L.newProfile({ notifications: 'off', sound: 'off', ...(AGENTS ? { claudeCommand: `node "${LOAD}"` } : {}) })
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined, env: process.env.PB_HOST_INSPECT ? { NODE_OPTIONS: '--inspect=0' } : {} })
  const { page } = app
  const cdp = await page.createCDPSession()
  await cdp.send('Performance.enable')
  // PB_PERF_SLOW=4 runs the window's CPU four times slower, as on a modest laptop.
  if (process.env.PB_PERF_SLOW) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PB_PERF_SLOW) })
  // PB_PERF_HIDPI=1 draws a 2560x1440 window at twice the pixels, as a 4K screen scaled to 200% does.
  if (process.env.PB_PERF_HIDPI) await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1440, deviceScaleFactor: 2, mobile: false })
  const ids = Array.from({ length: N }, (_, i) => `busy${i}`)
  try {
    const cols = Math.ceil(Math.sqrt(N + 1))
    const place = (i) => [(i % cols) * 500, Math.floor(i / cols) * 320]
    await L.openNode(page, L.terminal('typing', cwd, ...place(N)))
    await L.waitFor('the shell', async () => (await L.snapshot(page, 'typing')).includes('$'), 60000)
    if (!AGENTS) {
      for (const [i, id] of ids.entries()) await L.openNode(page, L.terminal(id, cwd, ...place(i)))
      await L.waitFor('the shells', async () => {
        const waiting = (await Promise.all(ids.map((id) => L.snapshot(page, id)))).flatMap((s, i) => (s.includes('$') ? [] : [ids[i]]))
        return waiting.length ? Promise.reject(new Error(`no prompt yet in ${waiting.join(', ')}`)) : true
      }, 60000)
    }
    await L.fitView(page)
    await L.sleep(2000)

    // Idle first: every terminal open and nothing happening.
    const idleCpu0 = cpuTimes(profile)
    await L.sleep(5000)
    const idleCpu = percentOfCore(idleCpu0, cpuTimes(profile), 5)
    console.log('IDLE cpu % of one core', JSON.stringify(idleCpu))

    if (AGENTS) {
      for (const [i, id] of ids.entries()) await L.openNode(page, { ...L.claude(id, cwd, ...place(i)), width: 480, height: 300, prompt: `${SECONDS + 30}${HEAVY ? ' heavy' : ''}` })
      await L.sleep(6000)
      if (CHAT) {
        // Clicked in the page: at this zoom the ⋯ button may be hidden on a far header, which a real click can't reach.
        for (const id of ids) {
          await page.evaluate((i) => document.querySelector(`.react-flow__node[data-id="${i}"] [data-tool="more"]`)?.click(), id)
          await page.waitForSelector('.menu-panel [data-tool="chat"]', { timeout: 3000 })
          await page.evaluate(() => document.querySelector('.menu-panel [data-tool="chat"]')?.click())
          await L.sleep(50)
        }
        await L.sleep(1500)
        const chats = await page.evaluate(() => document.querySelectorAll('.chat-list').length)
        c.check('Every agent window shows its chat', chats === N, { chats, of: N })
      }
    } else {
      for (const id of ids) await L.submit(page, id, `node "${LOAD}" ${SECONDS + 30}${HEAVY ? ' --heavy' : ''}`)
      await L.sleep(4000)
    }
    const working = (await Promise.all(ids.map((id) => L.snapshot(page, id)))).filter((s) => s.includes('Working…')).length
    c.check('Every busy terminal is printing', working === N, { working, of: N })
    if (process.env.PB_PERF_SHOT) await L.shot(page, 'perf-load')

    await page.click('.react-flow__node[data-id="typing"] .xterm-screen')
    await startWatching(page)
    const busy0 = await busyMetrics(cdp)
    const cpu0 = cpuTimes(profile)
    const machine0 = machineTimes()
    const programs0 = process.env.PB_PERF_TOP ? cpuByProgram() : null
    const wall0 = Date.now()
    const wantProfile = !!process.env.PB_PERF_PROFILE
    if (wantProfile) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
      await cdp.send('Profiler.start')
    }
    // PB_PERF_TRACE=<file.json>: a Chromium trace of every process's threads, summed by thread and task.
    const traceSession = process.env.PB_PERF_TRACE ? await app.browser.target().createCDPSession() : null
    const traceEvents = []
    if (traceSession) {
      traceSession.on('Tracing.dataCollected', (e) => traceEvents.push(...e.value))
      await traceSession.send('Tracing.start', { traceConfig: { includedCategories: ['toplevel', 'toplevel.flow', 'ipc', 'mojom', 'v8', 'electron', 'node', 'base', 'disabled-by-default-devtools.timeline'] }, transferMode: 'ReportEvents' })
    }
    const mainProfile = process.env.PB_MAIN_INSPECT ? profileMain(process.env.PB_MAIN_INSPECT, Math.min(15, SECONDS - 2)) : null
    // PB_HOST_INSPECT=1: every process was started with a debugger on a port of its own, so the host's is found by its pid.
    let hostProfile = null
    if (process.env.PB_HOST_INSPECT) {
      const pid = L.hostPid(profile)
      const line = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/).find((l) => /LISTENING/.test(l) && l.trim().endsWith(` ${pid}`) && /127\.0\.0\.1:\d+/.test(l))
      const port = line && /127\.0\.0\.1:(\d+)/.exec(line)[1]
      hostProfile = port ? profileMain(port, Math.min(15, SECONDS - 2)) : Promise.resolve([`no debugger port found for host ${pid}`])
    }
    const keys = []
    const mains = []
    let k = 0
    while (Date.now() - wall0 < SECONDS * 1000) {
      keys.push(await keyLatency(page, 'typing', `k${k++}x`))
      const t = Date.now()
      await page.evaluate(() => window.patchbay.getApprovals())
      mains.push(Date.now() - t)
      if (k % 5 === 0) await page.keyboard.down('Control').then(() => page.keyboard.press('u')).then(() => page.keyboard.up('Control'))
      await L.sleep(400)
    }
    const seconds = (Date.now() - wall0) / 1000
    const cpu = percentOfCore(cpu0, cpuTimes(profile), seconds)
    const machine1 = machineTimes()
    const pc = { busyPercent: machinePercent(machine0, machine1), cores: machine1.cores }
    if (programs0) {
      // Only programs still running count here, so short-lived ones show up by how many are running at the moment.
      const programs1 = cpuByProgram()
      const top = Object.entries(programs1)
        .map(([name, p]) => [name, Math.round(((p.cpu - (programs0[name]?.cpu ?? 0)) / seconds) * 100), p.count])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
      console.log('PROGRAMS % of one core (running at the end)', JSON.stringify(top))
    }
    const busy1 = await busyMetrics(cdp)
    const frames = await stopWatching(page)
    if (wantProfile) {
      const { profile: prof } = await cdp.send('Profiler.stop')
      const top = summarizeProfile(prof)
      fs.writeFileSync(process.env.PB_PERF_PROFILE, JSON.stringify(top, null, 2))
      console.log('TOP self time in the window:\n' + top.slice(0, 25).join('\n'))
    }
    if (traceSession) {
      const done = new Promise((r) => traceSession.once('Tracing.tracingComplete', r))
      await traceSession.send('Tracing.end')
      await done
      const names = new Map()
      for (const e of traceEvents) if (e.ph === 'M' && (e.name === 'thread_name' || e.name === 'process_name')) names.set(e.name === 'thread_name' ? `${e.pid}:${e.tid}` : `${e.pid}`, e.args.name)
      const sums = new Map()
      for (const e of traceEvents) {
        if (e.ph !== 'X' || !e.dur) continue
        const where = e.args?.src_func ? ` (${e.args.src_file?.split(/[\\/]/).pop()}:${e.args.src_func})` : ''
        const key = `${names.get(`${e.pid}`) ?? e.pid} / ${names.get(`${e.pid}:${e.tid}`) ?? e.tid} / ${e.name}${where}`
        sums.set(key, (sums.get(key) ?? 0) + e.dur / 1000)
      }
      const top = [...sums].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, ms]) => `${String(Math.round(ms)).padStart(7)} ms  ${k}`)
      fs.writeFileSync(process.env.PB_PERF_TRACE, top.join('\n'))
      console.log('TRACE top tasks (ms over the run):\n' + top.slice(0, 30).join('\n'))
    }
    if (hostProfile) console.log('TOP self time in the session host:\n' + (await hostProfile).slice(0, 30).join('\n'))
    if (mainProfile) console.log('TOP self time in the main process:\n' + (await mainProfile).slice(0, 30).join('\n'))
    const share = (a, b) => Math.round(((b - a) / seconds) * 100)
    const busy = { task: share(busy0.task, busy1.task), script: share(busy0.script, busy1.script), layout: share(busy0.layout, busy1.layout), style: share(busy0.style, busy1.style) }
    const sorted = [...keys].sort((a, b) => a - b)
    const keyStats = { samples: keys.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted.at(-1) }
    const mainStats = { p50: [...mains].sort((a, b) => a - b)[Math.floor(mains.length / 2)], worst: Math.max(...mains) }
    console.log('LOAD', N, AGENTS ? 'agents' : 'terminals', HEAVY ? '(heavy)' : '', CHAT ? '(chat)' : '', 'for', Math.round(seconds), 's')
    console.log('CPU % of one core', JSON.stringify(cpu))
    console.log('PC busy % of all cores', JSON.stringify(pc))
    console.log('MEMORY MB by process', JSON.stringify(processStats(profile).memory))
    console.log('WINDOW busy % of the time', JSON.stringify(busy))
    console.log('FRAMES', JSON.stringify(frames))
    console.log('KEYS ms', JSON.stringify(keyStats))
    console.log('MAIN answer ms', JSON.stringify(mainStats))
    if (process.env.PB_PERF_OUT) fs.writeFileSync(process.env.PB_PERF_OUT, JSON.stringify({ N, HEAVY, AGENTS, CHAT, idleCpu, cpu, pc, busy, frames, keyStats, mainStats }, null, 2))

    if (!process.env.PB_PERF_REPORT) {
      c.check('A key shows within 150 ms, most of the time, while every agent works', keyStats.p50 <= 150, keyStats)
      c.check('No key takes longer than 600 ms to show', keyStats.worst <= 600, keyStats)
      c.check('The window never goes a second without drawing', frames.worstFrameGap < 1000, frames)
      c.check('The main process answers within 250 ms', mainStats.worst < 250, mainStats)
      c.check('The window is idle at least a third of the time', busy.task < 67, busy)
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
