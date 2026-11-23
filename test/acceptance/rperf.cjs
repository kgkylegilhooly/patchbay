'use strict'
// Renderer performance harness (from the renderer audit, .claude/audits/renderer-perf.md). A heavy canvas: terminals printing like Claude, fake
// agents (claude-load.cjs), browser pages, notes, whiteboards, groups and cables, plus a second project. Each scenario
// is measured in the window: rAF frame gaps, Chromium's busy metrics, optionally a CPU profile, a trace summary and
// React commit/render counts (needs the profiling build: PB_RP_REACT=1).
//
// Env: PB_RP_OUT=<file.json>  PB_RP_PROFILE=1 (CPU profile per scenario)  PB_RP_TRACE=1 (paint/raster per scenario)
//      PB_RP_REACT=1 (React render counts; build with minify off + react-dom/profiling)  PB_RP_ONLY=a,b (scenarios)
//      PB_RP_TERMS (default 16) PB_RP_AGENTS (10) PB_RP_SLOW (CPU throttle) PB_RP_NOLOAD=1 (nothing printing)
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

if (require.main === module) U.watchdog(25 * 60_000)
const LOAD = path.join(__dirname, 'claude-load.cjs').replace(/\\/g, '/')
const TERMS = Number(process.env.PB_RP_TERMS ?? 16)
const AGENTS = Number(process.env.PB_RP_AGENTS ?? 10)
const ONLY = process.env.PB_RP_ONLY ? process.env.PB_RP_ONLY.split(',') : null
const SHOTS = process.env.PB_RP_SHOTS || path.join(__dirname, '..', '..', '..', 'shots')
const results = {}

function site() {
  const page = (i) => `<!doctype html><title>Page ${i}</title><style>body{font:15px sans-serif;margin:0;padding:16px;background:#fafafa}
.card{border-radius:10px;box-shadow:0 4px 18px #0002;padding:12px;margin:10px 0;background:#fff}
.spin{width:28px;height:28px;border:4px solid #49c2c9;border-top-color:transparent;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}</style><h1>Dashboard ${i}</h1><div class=spin></div>
${Array.from({ length: 12 }, (_, k) => `<div class=card>Row ${k}: build ${i}.${k} passed in ${(k * 1.7).toFixed(1)} s</div>`).join('')}
<script>let n=0;setInterval(()=>{document.querySelector('h1').textContent='Dashboard ${i} · '+(n++)},250)</script>`
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(page(req.url.replace(/\D/g, '') || '0'))
    })
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }))
  })
}

function canvas(cwd, port) {
  const nodes = []
  const edges = []
  const W = 480
  const H = 300
  // Three groups across the top, each holding a column of terminals and agents.
  const groupAt = (g) => ({ x: g * 1560, y: 0 })
  for (let g = 0; g < 3; g++) nodes.push({ id: `g${g}`, kind: 'group', title: `Team ${g}`, x: groupAt(g).x, y: 0, width: 1520, height: 1400, parentId: null, worktree: null, projectId: 'p1' })
  let slot = 0
  const place = () => {
    const g = slot % 3
    const k = Math.floor(slot / 3)
    slot++
    return { parentId: `g${g}`, x: 20 + (k % 3) * (W + 20), y: 60 + Math.floor(k / 3) * (H + 20) }
  }
  nodes.push({ id: 'typing', kind: 'terminal', title: 'typing', x: -560, y: 0, width: 520, height: 320, parentId: null, cwd, projectId: 'p1' })
  for (let i = 0; i < TERMS; i++) nodes.push({ id: `t${i}`, kind: 'terminal', title: `build ${i}`, ...place(), width: W, height: H, cwd, projectId: 'p1' })
  for (let i = 0; i < AGENTS; i++) {
    nodes.push({ id: `a${i}`, kind: 'claude', title: `agent ${i}`, ...place(), width: W, height: H, cwd, projectId: 'p1', prompt: process.env.PB_RP_NOLOAD ? 'idle' : '1500', sessionId: null, transcriptPath: null, after: [] })
    edges.push({ id: `ea${i}`, from: i ? 'a0' : 'typing', to: `a${i}`, kind: i % 2 ? 'opened' : 'link' })
  }
  // Below the groups: pages, notes and boards.
  for (let i = 0; i < 4; i++) nodes.push({ id: `b${i}`, kind: 'browser', title: `page ${i}`, url: `http://127.0.0.1:${port}/${i}`, x: i * 700, y: 1500, width: 640, height: 420, parentId: null, projectId: 'p1' })
  const md = (i) => `## Note ${i}\n- [ ] check the build\n- [x] write the plan\n\n\`\`\`js\nconst x = ${i}\nfor (const k of [1,2,3]) console.log(k * x)\n\`\`\`\n**Bold** and _italic_ and a [link](https://example.com).`
  for (let i = 0; i < 8; i++) nodes.push({ id: `n${i}`, kind: 'sticky', title: `Note ${i}`, text: md(i), color: ['yellow', 'blue', 'green', 'pink'][i % 4], x: i ? (i % 4) * 340 : -560, y: i ? 2000 + Math.floor(i / 4) * 300 : 380, width: 300, height: 260, parentId: null, projectId: 'p1' })
  const shapes = Array.from({ length: 60 }, (_, k) => (k % 3 === 0 ? { type: 'pen', color: '#e2b04a', size: 3, points: Array.from({ length: 40 }, (_, j) => [20 + j * 8, 40 + Math.sin(j / 3 + k) * 30 + k * 4]).flat() } : { type: k % 3 === 1 ? 'rect' : 'ellipse', color: '#49c2c9', size: 2, x1: (k * 13) % 500, y1: (k * 29) % 300, x2: ((k * 13) % 500) + 60, y2: ((k * 29) % 300) + 40 }))
  for (let i = 0; i < 2; i++) nodes.push({ id: `w${i}`, kind: 'whiteboard', title: `Board ${i}`, shapes, x: 1400 + i * 640, y: 2000, width: 600, height: 420, parentId: null, projectId: 'p1' })
  for (let i = 0; i < 6; i++) edges.push({ id: `en${i}`, from: `n${i}`, to: `t${i}`, kind: 'link' })
  for (let i = 0; i < 4; i++) edges.push({ id: `eb${i}`, from: `a${i}`, to: `b${i}`, kind: 'opened' })
  // Project 2: lighter.
  for (let i = 0; i < 6; i++) nodes.push({ id: `p2t${i}`, kind: 'terminal', title: `p2 term ${i}`, x: (i % 3) * 500, y: Math.floor(i / 3) * 320, width: W, height: H, parentId: null, cwd, projectId: 'p2' })
  for (let i = 0; i < 4; i++) nodes.push({ id: `p2n${i}`, kind: 'sticky', title: `p2 note ${i}`, text: md(i), x: i * 320, y: 700, width: 300, height: 240, parentId: null, projectId: 'p2' })
  return {
    version: 3,
    projects: [
      { id: 'p1', name: 'Heavy', folder: cwd, viewport: { x: 600, y: 40, zoom: 0.5 } },
      { id: 'p2', name: 'Light', folder: cwd, viewport: { x: 40, y: 40, zoom: 0.8 } }
    ],
    activeProjectId: 'p1',
    viewport: { x: 600, y: 40, zoom: 0.5 },
    edges,
    closed: [],
    nodes
  }
}

// ---- measurement in the window ----
const startFrames = (page) =>
  page.evaluate(() => {
    const w = (window.__rp = { gaps: [], stop: false })
    let last = performance.now()
    const tick = (now) => {
      w.gaps.push(now - last)
      last = now
      if (!w.stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
const stopFrames = (page) =>
  page.evaluate(() => {
    const w = window.__rp
    w.stop = true
    const g = w.gaps.slice(1)
    const s = [...g].sort((a, b) => a - b)
    const pct = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(1)
    const total = g.reduce((a, b) => a + b, 0)
    return { frames: g.length, fps: +((g.length / total) * 1000).toFixed(1), p50: pct(0.5), p95: pct(0.95), worst: +(s.at(-1) ?? 0).toFixed(0), over33: g.filter((x) => x > 33.4).length, over50: g.filter((x) => x > 50).length, jankMs: Math.round(g.filter((x) => x > 17.5).reduce((a, b) => a + b - 16.7, 0)) }
  })

async function metrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  const o = {}
  for (const m of metrics) o[m.name] = m.value
  return o
}
const KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'Nodes', 'JSHeapUsedSize']
function metricDelta(a, b, seconds) {
  const out = {}
  for (const k of KEYS) {
    if (k === 'Nodes' || k === 'JSHeapUsedSize') out[k] = k === 'Nodes' ? b[k] : Math.round(b[k] / 1048576)
    else if (/Duration/.test(k)) out[k.replace('Duration', '%')] = Math.round(((b[k] - a[k]) / seconds) * 100)
    else out[k + '/s'] = Math.round((b[k] - a[k]) / seconds)
  }
  return out
}

function summarizeProfile(profile, n = 25) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]))
  const counts = new Map()
  for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1)
  const self = new Map()
  for (const [id, k] of counts) {
    const f = byId.get(id).callFrame
    const file = f.url.split('/').pop()?.split('?')[0] || '(native)'
    const key = `${f.functionName || '(anon)'} ${file}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + k)
  }
  const total = profile.samples.length
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${((c / total) * 100).toFixed(1).padStart(5)}% ${k}`)
}

// React render counting through the DevTools hook (works with the profiling build's fiber timings).
const REACT_HOOK = () => {
  const stats = { commits: 0, commitMs: 0, byName: {} }
  window.__rr = stats
  window.__rrOn = false
  const nameOf = (f) => {
    const t = f.type
    if (!t) return null
    if (typeof t === 'function') return t.displayName || t.name || 'anon'
    if (t.displayName) return t.displayName
    if (t.render) return t.render.displayName || t.render.name || 'fwd'
    if (t.type) return nameOf({ type: t.type })
    return null
  }
  const COMPONENT = new Set([0, 1, 11, 14, 15])
  const walk = (f) => {
    let selfTotal = 0
    for (let c = f; c; c = c.sibling) {
      const alt = c.alternate
      const rendered = COMPONENT.has(c.tag) && (alt === null || (c.flags & 1) === 1)
      if (rendered) {
        const n = nameOf(c) || '?'
        const e = (stats.byName[n] ??= { renders: 0, selfMs: 0 })
        e.renders++
        if (typeof c.actualDuration === 'number') {
          let kids = 0
          for (let k = c.child; k; k = k.sibling) kids += k.actualDuration || 0
          e.selfMs += Math.max(0, c.actualDuration - kids)
        }
      }
      // A subtree that bailed out keeps the children from before: skip it.
      if (c.child && !(alt && alt.child === c.child)) walk(c.child)
    }
    return selfTotal
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject(r) {
      this.renderers.set(1, r)
      return 1
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!window.__rrOn) return
      stats.commits++
      const cur = root.current
      if (typeof cur.actualDuration === 'number') stats.commitMs += cur.actualDuration
      if (cur.child) walk(cur.child)
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {}
  }
}

/** CPU seconds so far of this run's Electron processes, by role (main, renderer, gpu-process, utility, host). */
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

async function scenario(ctx, name, fn) {
  if (ONLY && !ONLY.includes(name)) return
  const { page, cdp, browserCdp } = ctx
  await L.sleep(300)
  if (process.env.PB_RP_REACT) await page.evaluate(() => {
    window.__rr.commits = 0
    window.__rr.commitMs = 0
    window.__rr.byName = {}
    window.__rrOn = true
  })
  if (process.env.PB_RP_PROFILE) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
    await cdp.send('Profiler.start')
  }
  const traceEvents = []
  let onData
  if (process.env.PB_RP_TRACE) {
    onData = (e) => traceEvents.push(...e.value)
    browserCdp.on('Tracing.dataCollected', onData)
    await browserCdp.send('Tracing.start', { traceConfig: { includedCategories: ['toplevel', 'cc', 'gpu', 'viz', 'blink', 'disabled-by-default-devtools.timeline', 'v8'] }, transferMode: 'ReportEvents' })
  }
  const c0 = ctx.profile ? cpuByRole(ctx.profile) : null
  await startFrames(page)
  const m0 = await metrics(cdp)
  const t0 = Date.now()
  const extra = (await fn()) ?? {}
  const seconds = (Date.now() - t0) / 1000
  const m1 = await metrics(cdp)
  if (c0) {
    const c1 = cpuByRole(ctx.profile)
    // Percent of one core over the scenario, per process role. The sampling itself sits outside the window.
    extra.cpu = Object.fromEntries(Object.keys(c1).map((k) => [k, Math.round(((c1[k] - (c0[k] ?? 0)) / seconds) * 100)]))
  }
  const frames = await stopFrames(page)
  const r = { seconds: +seconds.toFixed(1), frames, busy: metricDelta(m0, m1, seconds), ...extra }
  if (process.env.PB_RP_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop')
    r.profile = summarizeProfile(profile)
  }
  if (process.env.PB_RP_TRACE) {
    const done = new Promise((res) => browserCdp.once('Tracing.tracingComplete', res))
    await browserCdp.send('Tracing.end')
    await done
    browserCdp.off('Tracing.dataCollected', onData)
    r.trace = traceSummary(traceEvents, seconds)
  }
  if (process.env.PB_RP_REACT) {
    const rr = await page.evaluate(() => {
      window.__rrOn = false
      return window.__rr
    })
    const top = Object.entries(rr.byName).sort((a, b) => b[1].renders - a[1].renders).slice(0, 25).map(([n, e]) => `${String(e.renders).padStart(6)} renders ${e.selfMs.toFixed(0).padStart(5)} ms  ${n}`)
    const bySelf = Object.entries(rr.byName).sort((a, b) => b[1].selfMs - a[1].selfMs).slice(0, 15).map(([n, e]) => `${e.selfMs.toFixed(0).padStart(6)} ms ${String(e.renders).padStart(6)} renders  ${n}`)
    r.react = { commits: rr.commits, commitsPerS: +(rr.commits / seconds).toFixed(1), renderMs: Math.round(rr.commitMs), top, bySelf }
  }
  results[name] = r
  console.log(`\n=== ${name} (${r.seconds}s)`)
  console.log('frames', JSON.stringify(frames))
  console.log('busy', JSON.stringify(r.busy))
  for (const k of Object.keys(extra)) console.log(k, JSON.stringify(extra[k]))
  if (r.profile) console.log('profile\n  ' + r.profile.slice(0, 18).join('\n  '))
  if (r.trace) console.log('trace\n  ' + r.trace.slice(0, 22).join('\n  '))
  if (r.react) console.log(`react commits ${r.react.commits} (${r.react.commitsPerS}/s) render ${r.react.renderMs} ms\n  ` + r.react.top.slice(0, 18).join('\n  ') + '\n by self time\n  ' + r.react.bySelf.join('\n  '))
}

function traceSummary(events, seconds) {
  const names = new Map()
  for (const e of events) if (e.ph === 'M' && (e.name === 'thread_name' || e.name === 'process_name')) names.set(e.name === 'thread_name' ? `${e.pid}:${e.tid}` : `${e.pid}`, e.args.name)
  const sums = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue
    if (!/^(Paint|PaintImage|RasterTask|Layout|UpdateLayoutTree|RecalculateStyles|UpdateLayerTree|Layerize|PrePaint|CompositeLayers|Commit|ParseHTML|FunctionCall|EvaluateScript|TimerFire|FireAnimationFrame|EventDispatch|HitTest|ImageDecodeTask|Decode Image|DrawFrame|ProxyMain::BeginMainFrame|ThreadProxy::BeginMainFrame|BeginMainFrame|LayerTreeHostImpl::PrepareToDraw|Graphics.Pipeline|GpuChannel|CommandBufferStub|Display::DrawAndSwap|SkiaOutputSurfaceImplOnGpu::SwapBuffers|TileManager::FlushAndIssueSignals|ScheduledTasks|RunTask|ThreadControllerImpl::RunTask|IntersectionObserverController::computeIntersections|ResizeObserverController|ScrollLayer|Animation)/.test(e.name)) continue
    const thread = names.get(`${e.pid}:${e.tid}`) ?? e.tid
    const proc = names.get(`${e.pid}`) ?? e.pid
    const key = `${proc}/${thread}/${e.name}`
    sums.set(key, (sums.get(key) ?? 0) + e.dur / 1000)
  }
  return [...sums].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, ms]) => `${String(Math.round(ms / seconds)).padStart(5)} ms/s  ${k}`)
}

// ---- interactions ----
async function pan(page, at, seconds) {
  const end = Date.now() + seconds * 1000
  let dir = 1
  while (Date.now() < end) {
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (let i = 1; i <= 30; i++) await page.mouse.move(at.x - dir * i * 12, at.y - dir * i * 4)
    await page.mouse.up()
    dir = -dir
  }
}
async function wheelZoom(page, at, seconds) {
  await page.mouse.move(at.x, at.y)
  const end = Date.now() + seconds * 1000
  let dir = 1
  let k = 0
  while (Date.now() < end) {
    await page.mouse.wheel({ deltaY: dir * 60 })
    await L.sleep(16)
    if (++k % 12 === 0) dir = -dir
  }
}
async function dragNode(page, id, seconds) {
  const box = await page.evaluate((i) => {
    const el = document.querySelector(`.react-flow__node[data-id="${i}"] .unit-head, .react-flow__node[data-id="${i}"] .note-head, .react-flow__node[data-id="${i}"] header`)
    const r = el.getBoundingClientRect()
    return { x: r.left + Math.min(60, r.width / 3), y: r.top + r.height / 2 }
  }, id)
  const end = Date.now() + seconds * 1000
  let dir = 1
  while (Date.now() < end) {
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + dir * i * 6, box.y + dir * i * 2)
    await page.mouse.up()
    box.x += dir * 180
    box.y += dir * 60
    dir = -dir
  }
}
/** Key to echo, as perf.cjs does it. */
async function keyLatency(page, id, token) {
  const shown = page.evaluate(
    (i, tok) =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const check = () => {
          const t = document.querySelector(`.react-flow__node[data-id="${i}"] .xterm-rows`)?.textContent ?? ''
          if (t.includes(tok)) resolve(Math.round(performance.now() - t0))
          else if (performance.now() - t0 > 10000) resolve(10000)
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
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return { n: s.length, p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], worst: s.at(-1) }
}
/** Click (in page) and time to two frames later: the cost of opening something. */
const timedClick = (page, selector) =>
  page.evaluate(async (sel) => {
    const el = document.querySelector(sel)
    if (!el) return -1
    const t0 = performance.now()
    el.click()
    const tSync = performance.now() - t0
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return { syncMs: Math.round(tSync), paintedMs: Math.round(performance.now() - t0) }
  }, selector)
const timedKey = async (page, mods, key, waitSel) => {
  await page.evaluate(() => {
    window.__k0 = performance.now()
  })
  for (const m of mods) await page.keyboard.down(m)
  await page.keyboard.press(key)
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
  return page.evaluate(async (sel) => {
    const t = performance.now()
    while (!document.querySelector(sel) && performance.now() - t < 5000) await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return Math.round(performance.now() - window.__k0)
  }, waitSel)
}

/** Waits, counting how often terminal rows were rebuilt (xterm drawing) per second, across all terminals. */
async function rowChanges(page, ms) {
  await page.evaluate(() => {
    window.__rows = 0
    window.__rowObs = new MutationObserver((list) => { window.__rows += list.length })
    for (const el of document.querySelectorAll('.xterm-rows')) window.__rowObs.observe(el, { childList: true, subtree: true, characterData: true })
  })
  await L.sleep(ms)
  const n = await page.evaluate(() => { window.__rowObs.disconnect(); return window.__rows })
  return { rowMutationsPerS: Math.round(n / (ms / 1000)) }
}

async function main() {
  const s = await site()
  const cwd = L.workDir('rperf')
  const profile = L.newProfile({ claudeCommand: `node "${LOAD}"`, notifications: 'off', sound: 'off' })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(canvas(cwd, s.port)))
  fs.mkdirSync(SHOTS, { recursive: true })
  const app = await L.launch({ profile })
  const { page } = app
  const cdp = await page.createCDPSession()
  await cdp.send('Performance.enable')
  const browserCdp = await app.browser.target().createCDPSession()
  const ctx = { page, cdp, browserCdp, profile }
  try {
    if (process.env.PB_RP_REACT) {
      await page.evaluateOnNewDocument(`(${REACT_HOOK.toString()})()`)
      await page.reload()
      await page.waitForSelector('.react-flow', { timeout: 20000 })
    }
    if (process.env.PB_RP_SLOW) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PB_RP_SLOW) })
    const termIds = ['typing', ...Array.from({ length: TERMS }, (_, i) => `t${i}`)]
    await L.waitFor('the shells', async () => {
      const shown = await Promise.all(termIds.map((id) => L.snapshot(page, id)))
      const waiting = shown.flatMap((x, i) => (x.includes('$') ? [] : [termIds[i]]))
      return waiting.length ? Promise.reject(new Error(`waiting on ${waiting.join(',')}`)) : true
    }, 240000)
    await L.sleep(1500)
    const counts = await page.evaluate(() => ({ nodes: document.querySelectorAll('.react-flow__node').length, edges: document.querySelectorAll('.react-flow__edge').length, xterms: document.querySelectorAll('.xterm').length, webviews: document.querySelectorAll('webview').length, dom: document.getElementsByTagName('*').length }))
    console.log('SCENE', JSON.stringify(counts))
    results.scene = counts

    await scenario(ctx, 'quiet', () => L.sleep(5000))
    if (!process.env.PB_RP_NOLOAD) {
      for (const [i, id] of termIds.slice(1).entries()) await L.submit(page, id, `node "${LOAD}" 1500${i % 4 === 3 ? ' --heavy' : ''}`)
      await L.sleep(5000)
    }
    await page.screenshot({ path: path.join(SHOTS, `scene-${process.env.PB_RP_TAG || 'run'}.png`) })
    await scenario(ctx, 'output', () => rowChanges(page, 6000))

    // Typing.
    const typingBox = await page.evaluate(() => {
      const r = document.querySelector('.react-flow__node[data-id="typing"] .xterm-screen').getBoundingClientRect()
      return { x: r.left + 40, y: r.top + 40, visible: r.width > 0 && r.left > 0 && r.top > 0 && r.right < innerWidth }
    })
    await page.mouse.click(typingBox.x, typingBox.y)
    await scenario(ctx, 'typing', async () => {
      const keys = []
      const end = Date.now() + 8000
      let k = 0
      while (Date.now() < end) {
        keys.push(await keyLatency(page, 'typing', `k${k++}x`))
        if (k % 6 === 0) {
          await page.keyboard.down('Control')
          await page.keyboard.press('u')
          await page.keyboard.up('Control')
        }
        await L.sleep(120)
      }
      return { keys: stat(keys), visible: typingBox.visible }
    })
    // Where a key's time goes: keydown -> its echo arriving in the window (main, host, shell) -> shown in the rows.
    await scenario(ctx, 'typing-split', async () => {
      await page.evaluate(() => {
        const w = (window.__ts = { keys: [], outs: [], rows: [] })
        window.addEventListener('keydown', (e) => { if (/^[a-z]$/.test(e.key)) w.keys.push([e.key, performance.now()]) }, true)
        window.patchbay.onOutput((id, data) => { if (id === 'typing') w.outs.push([data, performance.now()]) })
      })
      const split = []
      for (let i = 0; i < 30; i++) {
        const ch = 'abcdefghij'[i % 10]
        // Shown: the moment xterm puts the echo in its rows (a mutation, not a frame poll, so it isn't rounded up a frame).
        const shownAt = page.evaluate((c) => new Promise((resolve) => {
          const rows = document.querySelector('.react-flow__node[data-id="typing"] .xterm-rows')
          const want = (rows?.textContent ?? '').split(c).length
          const done = (t) => { obs.disconnect(); clearTimeout(timer); resolve(t) }
          const obs = new MutationObserver(() => { if ((rows.textContent ?? '').split(c).length > want) done(performance.now()) })
          obs.observe(rows, { childList: true, subtree: true, characterData: true })
          const timer = setTimeout(() => done(null), 5000)
        }), ch)
        await page.keyboard.press(ch)
        const shown = await shownAt
        const r = await page.evaluate((c) => {
          const w = window.__ts
          const k = w.keys.filter(([x]) => x === c).at(-1)?.[1]
          const o = w.outs.find(([d, t]) => t >= k && d.includes(c))?.[1]
          return { k, o }
        }, ch)
        if (r.k && r.o && shown) split.push({ roundTrip: Math.round(r.o - r.k), draw: Math.round(shown - r.o), total: Math.round(shown - r.k) })
        await L.sleep(150)
        if (i % 10 === 9) {
          await page.keyboard.down('Control')
          await page.keyboard.press('u')
          await page.keyboard.up('Control')
          // The shell redraws the cleared line a moment later: wait, so the next key's starting count is taken after it.
          await L.sleep(400)
        }
      }
      return { roundTrip: stat(split.map((x) => x.roundTrip)), draw: stat(split.map((x) => x.draw)), total: stat(split.map((x) => x.total)) }
    })
    await scenario(ctx, 'drag-terminal', () => dragNode(page, 't0', 5))
    await scenario(ctx, 'drag-note', () => dragNode(page, 'n0', 5))
    // Panels. The keyboard leaves the terminal first, since it keeps keys that aren't marked overTerminal.
    { const spot = await U.emptySpot(page); await page.mouse.click(spot.x, spot.y); await L.sleep(300) }
    await scenario(ctx, 'sidebar', async () => {
      const t = []
      for (let i = 0; i < 6; i++) {
        t.push(await timedKey(page, ['Control', 'Shift'], 'KeyE', 'body'))
        await L.sleep(400)
      }
      return { toggleMs: t }
    })
    await scenario(ctx, 'palette', async () => {
      const t = []
      for (let i = 0; i < 5; i++) {
        t.push(await timedKey(page, ['Control'], 'KeyK', '.palette'))
        await L.sleep(300)
        await page.keyboard.press('Escape')
        await L.sleep(300)
      }
      return { openMs: t }
    })
    await scenario(ctx, 'settings', async () => {
      const t = []
      for (let i = 0; i < 3; i++) {
        t.push(await timedKey(page, ['Control'], 'Comma', '.settings'))
        await L.sleep(500)
        await page.keyboard.press('Escape')
        await L.sleep(500)
      }
      return { openMs: t }
    })
    await scenario(ctx, 'switch-project', async () => {
      const t = []
      for (let i = 0; i < 4; i++) {
        const to = i % 2 ? 'p1' : 'p2'
        t.push(await page.evaluate(async (id) => {
          const t0 = performance.now()
          await window.patchbay.dispatch({ op: 'switchProject', id })
          const want = id === 'p2' ? 'p2t0' : 't0'
          while (!document.querySelector(`.react-flow__node[data-id="${want}"]`) && performance.now() - t0 < 8000) await new Promise((r) => requestAnimationFrame(r))
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          return Math.round(performance.now() - t0)
        }, to))
        await L.sleep(1500)
      }
      return { switchMs: t }
    })
    const at = await U.emptySpot(page)
    await scenario(ctx, 'pan', () => pan(page, at, 5))
    await scenario(ctx, 'zoom', () => wheelZoom(page, at, 5))
    await L.fitView(page)
    await L.sleep(800)
    const zoomFar = await page.evaluate(() => document.querySelector('.react-flow__viewport').style.transform)
    await scenario(ctx, 'output-far', async () => {
      const r = await rowChanges(page, 5000)
      return { transform: zoomFar, ...r }
    })
    const far = await U.emptySpot(page)
    await scenario(ctx, 'pan-far', () => pan(page, far, 5))
    await page.screenshot({ path: path.join(SHOTS, `end-${process.env.PB_RP_TAG || 'run'}.png`) })
    console.log('PROBLEMS', JSON.stringify(app.problems.slice(0, 5)))
  } finally {
    if (process.env.PB_RP_OUT) fs.writeFileSync(process.env.PB_RP_OUT, JSON.stringify(results, null, 2))
    await app.quit().catch(() => {})
    L.cleanup(profile)
    s.close()
  }
}

if (require.main === module) main().catch((e) => {
  console.error(e)
  process.exit(1)
})
module.exports = { site, canvas, startFrames, stopFrames, metrics, metricDelta, summarizeProfile, pan, wheelZoom, dragNode, keyLatency, stat, LOAD }
