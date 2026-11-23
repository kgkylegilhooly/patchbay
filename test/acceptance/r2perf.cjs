'use strict'
// Polish round 2, performance leftovers (docs/plans/r2-perf.md). One quiet off-screen launch per run, throwaway
// profile, no agent quota (fake agents). r2perf-ab.cjs runs it a few times per build, interleaved, and takes medians.
//
//   node test/acceptance/r2perf.cjs switch   [out.json]   project switches on rperf.cjs's 44-node scene
//   node test/acceptance/r2perf.cjs ticks    [out.json]   status ticks: what renders and paints per tick
//   node test/acceptance/r2perf.cjs startup  [out.json]   launch to usable canvas, 10 projects / 60 nodes, cold and warm
//
// Env: PB_RP_PROFILE=1 (CPU profile of the measured part)  PB_RP_REACT=1 (React render counts; profiling build, see
//      rperf.cjs)  PB_R2_SWITCHES (8)  PB_RP_SHELL=cmd (see rperf.cjs)  PB_RP_NOLOAD=1 (terminals stay quiet)
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const R = require('./rperf.cjs')

if (require.main === module) U.watchdog(25 * 60_000)
const SHELL = process.env.PB_RP_SHELL === 'cmd' ? 'C:\\Windows\\System32\\cmd.exe' : process.env.PB_RP_SHELL
const PROMPT = SHELL && /cmd/i.test(SHELL) ? '>' : '$'
const FAKE = path.join(__dirname, 'fake-claude.cjs').replace(/\\/g, '/')
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2] : +((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1)
}

// ---- in the window ----
/** Long animation frames (Chromium's LoAF), kept with where their time went, for attributing a slow frame. */
const LOAF = () => {
  window.__loaf = []
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.__loaf.push({
          start: e.startTime,
          dur: e.duration,
          // From the frame's start to its rendering (scripts and tasks), then style and layout, then the rest (paint etc).
          work: (e.renderStart || e.startTime + e.duration) - e.startTime,
          style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
          render: e.renderStart ? (e.styleAndLayoutStart || e.startTime + e.duration) - e.renderStart : 0,
          scripts: e.scripts.map((s) => ({ dur: Math.round(s.duration), forced: Math.round(s.forcedStyleAndLayoutDuration), what: `${s.invokerType}:${s.invoker}`.slice(0, 80), fn: s.sourceFunctionName, src: (s.sourceURL || '').split('/').pop() }))
        })
    }).observe({ type: 'long-animation-frame', buffered: false })
  } catch {}
}

/** One project switch, timed in the window: to the first frame that shows it, and every frame for a second after. */
const SWITCH = async (id, want) => {
  const gaps = []
  let last = performance.now()
  let stop = false
  const tick = (now) => {
    gaps.push([now, now - last])
    last = now
    if (!stop) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  await new Promise((r) => requestAnimationFrame(() => r()))
  for (const el of document.querySelectorAll('.xterm')) el.__r2seen = true
  const t0 = performance.now()
  const before = window.__loaf.length
  let docAt = 0
  const off = window.patchbay.onDoc(() => (docAt ||= performance.now()))
  void window.patchbay.dispatch({ op: 'switchProject', id })
  let seen = 0
  while (!document.querySelector(`.react-flow__node[data-id="${want}"]`) && performance.now() - t0 < 8000) await new Promise((r) => requestAnimationFrame(r))
  seen = performance.now()
  // The rAF after the one that found it: the frame that drew it has finished.
  await new Promise((r) => requestAnimationFrame(r))
  const shown = performance.now() - t0
  const builtByFirstFrame = [...document.querySelectorAll('.xterm')].filter((el) => !el.__r2seen).length
  off()
  const nodesFirst = document.querySelectorAll('.react-flow__node').length
  window.__sw = { gaps, t0, before, shown, seen, docAt, builtByFirstFrame, nodesFirst, stop: () => (stop = true) }
}

/** The rest of a switch: every frame for a second after it, and what it built. */
const SWITCH_END = async () => {
  const { gaps, t0, before, shown, seen, docAt, builtByFirstFrame, nodesFirst, stop } = window.__sw
  await new Promise((r) => setTimeout(r, 1000))
  const built = [...document.querySelectorAll('.xterm')].filter((el) => !el.__r2seen).length
  stop()
  const after = gaps.filter(([at]) => at > t0)
  const worst = Math.max(...after.map(([, g]) => g))
  const loafs = window.__loaf.slice(before).filter((e) => e.start + e.dur > t0 - 1)
  const top = loafs.sort((a, b) => b.dur - a.dur)[0]
  return {
    shownMs: Math.round(shown),
    built,
    builtByFirstFrame,
    docMs: Math.round(docAt - t0),
    nodes: `${nodesFirst}/${document.querySelectorAll('.react-flow__node').length}`,
    view: `${innerWidth}x${innerHeight}`,
    domMs: Math.round(seen - t0),
    worstFrame: Math.round(worst),
    over33: after.filter(([, g]) => g > 33.4).length,
    over50: after.filter(([, g]) => g > 50).length,
    loafs: loafs.length,
    top: top ? { dur: Math.round(top.dur), work: Math.round(top.work), style: Math.round(top.style), render: Math.round(top.render), scripts: top.scripts.sort((a, b) => b.dur - a.dur).slice(0, 4) } : null
  }
}

async function profileStart(cdp) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
}
async function profileStop(cdp) {
  const { profile } = await cdp.send('Profiler.stop')
  return R.summarizeProfile(profile, 30)
}
/**
 * Where the time went across several CPU profiles, idle left out: self and inclusive milliseconds per function
 * (inclusive counted once per sample, however deep the recursion).
 */
function busyProfile(profiles, n = 40) {
  const self = new Map()
  const incl = new Map()
  let busy = 0
  for (const profile of profiles) {
    const byId = new Map(profile.nodes.map((x) => [x.id, x]))
    const parent = new Map()
    for (const x of profile.nodes) for (const c of x.children ?? []) parent.set(c, x.id)
    const key = (x) => {
      const f = x.callFrame
      return `${f.functionName || '(anon)'} ${f.url.split('/').pop()?.split('?')[0] || '(native)'}:${f.lineNumber + 1}`
    }
    profile.samples.forEach((id, i) => {
      const ms = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000
      const x = byId.get(id)
      if (/^((idle|program|root))$/.test(x.callFrame.functionName)) return
      busy += ms
      self.set(key(x), (self.get(key(x)) ?? 0) + ms)
      const seen = new Set()
      for (let at = id; at !== undefined; at = parent.get(at)) {
        const k = key(byId.get(at))
        if (seen.has(k) || k.startsWith('(root)')) continue
        seen.add(k)
        incl.set(k, (incl.get(k) ?? 0) + ms)
      }
    })
  }
  const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${(ms / profiles.length).toFixed(1).padStart(7)} ms  ${k}`)
  return { busyMsPerProfile: +(busy / profiles.length).toFixed(1), self: fmt(self), inclusive: fmt(incl) }
}

/** Chromium's own trace of the window's main thread, for where a frame's time went outside script. */
async function traceStart(app) {
  app.__trace = { events: [], cdp: app.__traceCdp ??= await app.browser.target().createCDPSession() }
  app.__trace.on = (e) => app.__trace.events.push(...e.value)
  app.__trace.cdp.on('Tracing.dataCollected', app.__trace.on)
  await app.__trace.cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'v8.execute'] }, transferMode: 'ReportEvents' })
}
async function traceStop(app) {
  const t = app.__trace
  const done = new Promise((r) => t.cdp.once('Tracing.tracingComplete', r))
  await t.cdp.send('Tracing.end')
  await done
  t.cdp.off('Tracing.dataCollected', t.on)
  // The window's renderer main thread: the one with the most FunctionCall time.
  const byThread = new Map()
  for (const e of t.events) if (e.ph === 'X' && e.dur) byThread.set(`${e.pid}:${e.tid}`, (byThread.get(`${e.pid}:${e.tid}`) ?? 0) + (e.name === 'FunctionCall' ? e.dur : 0))
  const main = [...byThread].sort((a, b) => b[1] - a[1])[0]?.[0]
  const sums = {}
  for (const e of t.events) {
    if (e.ph !== 'X' || !e.dur || `${e.pid}:${e.tid}` !== main) continue
    if (!/^(Layout|UpdateLayoutTree|Paint|PrePaint|Layerize|Commit|HitTest|ParseHTML|IntersectionObserverController::computeIntersections|ResizeObserverController::deliverObservations|UpdateLayer|CompositeLayers|MajorGC|MinorGC|V8.GC_SCAVENGER|FunctionCall|EventDispatch|FireAnimationFrame|TimerFire|RunMicrotasks)$/.test(e.name)) continue
    sums[e.name] = (sums[e.name] ?? 0) + e.dur / 1000
  }
  return sums
}
function mergeTraces(traces) {
  const out = {}
  for (const t of traces) for (const [k, v] of Object.entries(t)) out[k] = (out[k] ?? 0) + v / traces.length
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(1)]))
}

async function reactStart(page) {
  if (!process.env.PB_RP_REACT) return
  await page.evaluate(() => {
    window.__rr.commits = 0
    window.__rr.commitMs = 0
    window.__rr.byName = {}
    window.__rrOn = true
  })
}
async function reactStop(page) {
  if (!process.env.PB_RP_REACT) return undefined
  const rr = await page.evaluate(() => {
    window.__rrOn = false
    return window.__rr
  })
  const byName = Object.fromEntries(Object.entries(rr.byName).map(([n, e]) => [n, { renders: e.renders, ms: +e.selfMs.toFixed(1) }]))
  const top = Object.entries(byName).sort((a, b) => b[1].renders - a[1].renders).slice(0, 25).map(([n, e]) => `${String(e.renders).padStart(6)} renders ${String(e.ms).padStart(7)} ms  ${n}`)
  return { commits: rr.commits, commitMs: Math.round(rr.commitMs), byName, top }
}

async function withReactHook(page) {
  if (!process.env.PB_RP_REACT) return
  await page.evaluateOnNewDocument(`(${R.REACT_HOOK.toString()})()`)
  await page.reload()
  await page.waitForSelector('.react-flow', { timeout: 20000 })
}

// ---- switch: rperf.cjs's scene ----
async function switchScenario() {
  const s = await R.site()
  const cwd = L.workDir('r2perf-switch')
  const LOAD = R.LOAD
  const profile = L.newProfile({ claudeCommand: `node "${LOAD}"`, notifications: 'off', sound: 'off', ...(SHELL ? { shell: SHELL } : {}) })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(R.canvas(cwd, s.port)))
  const app = await L.launch({ profile })
  const { page } = app
  const cdp = await page.createCDPSession()
  const out = {}
  try {
    await withReactHook(page)
    const termIds = ['typing', ...Array.from({ length: 16 }, (_, i) => `t${i}`)]
    await L.waitFor('the shells', async () => {
      const shown = await Promise.all(termIds.map((id) => L.snapshot(page, id)))
      return shown.every((x) => x.includes(PROMPT))
    }, 240000)
    if (!process.env.PB_RP_NOLOAD) for (const [i, id] of termIds.slice(1).entries()) await L.submit(page, id, `node "${LOAD}" 1500${i % 4 === 3 ? ' --heavy' : ''}`)
    await L.sleep(5000)
    await page.evaluate(LOAF)
    // A first visit to p2 builds its terminals: a different thing (perf-terminals' mount queue). Warm both first.
    for (const id of ['p2', 'p1']) {
      await page.evaluate(SWITCH, id, id === 'p2' ? 'p2t0' : 't0')
      await page.evaluate(SWITCH_END)
      await L.sleep(1500)
    }
    const n = Number(process.env.PB_R2_SWITCHES || 8)
    const runs = []
    await reactStart(page)
    const profiles = []
    const traces = []
    for (let i = 0; i < n; i++) {
      const to = i % 2 ? 'p1' : 'p2'
      if (process.env.PB_RP_PROFILE) await profileStart(cdp)
      if (process.env.PB_RP_TRACE) await traceStart(app)
      await page.evaluate(SWITCH, to, to === 'p2' ? 'p2t0' : 't0')
      // The profile covers the switch to the end of its first frame, no more.
      if (process.env.PB_RP_PROFILE) profiles.push((await cdp.send('Profiler.stop')).profile)
      if (process.env.PB_RP_TRACE) traces.push(await traceStop(app))
      const r = await page.evaluate(SWITCH_END)
      runs.push({ to, ...r })
      console.log(to, JSON.stringify(r))
      await L.sleep(1200)
    }
    if (process.env.PB_RP_PROFILE) out.profile = busyProfile(profiles)
    if (process.env.PB_RP_TRACE) out.trace = mergeTraces(traces)
    out.react = await reactStop(page)
    const of = (to, k) => median(runs.filter((r) => r.to === to).map((r) => r[k]))
    out.summary = {
      'to p2 shown ms': of('p2', 'shownMs'),
      'to p1 shown ms': of('p1', 'shownMs'),
      'doc from main ms': median(runs.map((r) => r.docMs)),
      'to p2 worst frame': of('p2', 'worstFrame'),
      'to p1 worst frame': of('p1', 'worstFrame'),
      'worst frame (all)': median(runs.map((r) => r.worstFrame)),
      'over 50 ms per switch': median(runs.map((r) => r.over50)),
      'terminals built per switch': median(runs.map((r) => r.built)),
      'top LoAF ms': median(runs.map((r) => r.top?.dur ?? 0)),
      'top LoAF script ms': median(runs.map((r) => r.top?.work ?? 0)),
      'top LoAF style+layout ms': median(runs.map((r) => r.top?.style ?? 0)),
      'top LoAF render ms': median(runs.map((r) => r.top?.render ?? 0))
    }
    out.runs = runs
    out.problems = app.problems.slice(0, 5)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
    s.close()
  }
  return out
}

// ---- ticks: status changes on a canvas with the sidebar open ----
// 12 fake agents in "turns" mode (a typed "busy" starts a turn, "done" ends it), chained by one-way cables, plus three
// more projects of sessions so the sidebar is long. Each tick flips one agent. Measured with the view on the agents
// (their cables on screen) and with the view moved away from them (every cable off screen).
function ticksCanvas(cwd) {
  const nodes = []
  const edges = []
  const projects = []
  for (let p = 0; p < 4; p++) projects.push({ id: `p${p}`, name: `Project ${p}`, folder: cwd, viewport: { x: 40, y: 40, zoom: 0.5 } })
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: `a${i}`, kind: 'claude', title: `agent ${i}`, x: (i % 4) * 520, y: Math.floor(i / 4) * 360, width: 480, height: 320, parentId: null, cwd, projectId: 'p0', prompt: 'turns', sessionId: null, transcriptPath: null, after: [] })
    if (i) edges.push({ id: `e${i}`, from: `a${i - 1}`, to: `a${i}`, kind: 'opened' })
  }
  for (let i = 0; i < 8; i++) nodes.push({ id: `n${i}`, kind: 'sticky', title: `Note ${i}`, text: `note ${i}`, x: 4000 + i * 320, y: 3000, width: 300, height: 200, parentId: null, projectId: 'p0' })
  for (let p = 1; p < 4; p++) for (let i = 0; i < 8; i++) nodes.push({ id: `p${p}t${i}`, kind: 'terminal', title: `p${p} term ${i}`, x: (i % 4) * 500, y: Math.floor(i / 4) * 320, width: 480, height: 300, parentId: null, cwd, projectId: `p${p}` })
  return { version: 3, projects, activeProjectId: 'p0', viewport: projects[0].viewport, nodes, edges, closed: [] }
}

async function ticksScenario() {
  const cwd = L.workDir('r2perf-ticks')
  const profile = L.newProfile({ claudeCommand: `node "${FAKE}"`, notifications: 'off', sound: 'off', usageSource: 'off', ...(SHELL ? { shell: SHELL } : {}) })
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(ticksCanvas(cwd)))
  const app = await L.launch({ profile })
  const { page } = app
  const cdp = await page.createCDPSession()
  await cdp.send('Performance.enable')
  const ids = Array.from({ length: 12 }, (_, i) => `a${i}`)
  const out = {}
  try {
    await withReactHook(page)
    await L.waitFor('the agents to start', async () => {
      const s = await L.statuses(page)
      return ids.every((id) => s[id] === 'idle' || s[id] === 'unknown')
    }, 120000)
    // Every agent busy, so every cable's dots move.
    for (const id of ids) await L.input(page, id, 'busy\r')
    await L.waitFor('every agent working', async () => {
      const s = await L.statuses(page)
      return ids.every((id) => s[id] === 'working')
    }, 30000)
    // The sidebar open, pinned, on each tab in turn.
    const tab = async (t) => page.evaluate((x) => document.querySelector(`[data-sidebar-tab="${x}"]`)?.click(), t)
    const sidebarOpen = () => page.evaluate(() => !!document.querySelector('.sidebar'))
    if (!(await sidebarOpen())) {
      const spot = await U.emptySpot(page)
      await page.mouse.click(spot.x, spot.y)
      await page.keyboard.down('Control')
      await page.keyboard.down('Shift')
      await page.keyboard.press('KeyE')
      await page.keyboard.up('Shift')
      await page.keyboard.up('Control')
      await L.waitFor('the sidebar', sidebarOpen, 5000)
    }
    await page.evaluate(() => document.querySelector('[data-sidebar="pin"][aria-pressed="false"]')?.click())
    // a11 stays working and a0 too, so the chain's ends keep cables moving; a5 flips: two cables change each tick.
    const flip = async (seconds) => {
      const before = (await L.seenStatuses(page, 'a5')).length
      const end = Date.now() + seconds * 1000
      let k = 0
      while (Date.now() < end) {
        await L.input(page, 'a5', k++ % 2 ? 'busy\r' : 'done\r')
        await L.sleep(500)
      }
      // Status changes the window was sent for a5 meanwhile: the ticks measured.
      return (await L.seenStatuses(page, 'a5')).length - before
    }
    const measure = async (name, fn) => {
      await L.sleep(800)
      if (process.env.PB_RP_PROFILE) await profileStart(cdp)
      await reactStart(page)
      const c0 = R.cpuByRole(profile)
      const m0 = await R.metrics(cdp)
      const t0 = Date.now()
      const extra = await fn()
      const seconds = (Date.now() - t0) / 1000
      const m1 = await R.metrics(cdp)
      const c1 = R.cpuByRole(profile)
      const r = { seconds: +seconds.toFixed(1), ticks: extra, busy: R.metricDelta(m0, m1, seconds), cpu: Object.fromEntries(Object.keys(c1).map((k) => [k, Math.round(((c1[k] - (c0[k] ?? 0)) / seconds) * 100)])) }
      r.react = await reactStop(page)
      if (process.env.PB_RP_PROFILE) r.profile = await profileStop(cdp)
      out[name] = r
      console.log(`\n=== ${name}`, JSON.stringify({ busy: r.busy, cpu: r.cpu, ticks: r.ticks }))
      if (r.react) console.log('  ' + r.react.top.slice(0, 14).join('\n  '))
      if (r.profile) console.log('  ' + r.profile.slice(0, 12).join('\n  '))
    }
    await tab('project')
    await measure('ticks-project-tab', () => flip(10))
    await tab('status')
    await measure('ticks-status-tab', () => flip(10))
    // Every cable off screen: the view on the notes, far from the agents, at a zoom where the dots move.
    await moveViewTo(page, { x: -4000 * 0.5 + 100, y: -3000 * 0.5 + 100, zoom: 0.5 })
    out.offscreenCables = await page.evaluate(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect()
      return [...document.querySelectorAll('.cable-flow')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.right > stage.left && r.left < stage.right && r.bottom > stage.top && r.top < stage.bottom
      }).length
    })
    console.log('cables on screen after moving away:', out.offscreenCables)
    await measure('quiet-cables-offscreen', () => L.sleep(8000).then(() => 0))
    await moveViewTo(page, { x: 40, y: 40, zoom: 0.5 })
    await measure('quiet-cables-onscreen', () => L.sleep(8000).then(() => 0))
    out.problems = app.problems.slice(0, 5)
  } finally {
    await app.quit().catch(() => {})
    L.cleanup(profile)
  }
  return out
}

/** Pans the view (zoom unchanged) by dragging the empty canvas, so it ends where `vp` says, and lets it settle. */
async function moveViewTo(page, vp) {
  const now = await page.evaluate(() => {
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(document.querySelector('.react-flow__viewport').style.transform)
    return { x: Number(m[1]), y: Number(m[2]) }
  })
  let left = { x: vp.x - now.x, y: vp.y - now.y }
  while (Math.abs(left.x) > 1 || Math.abs(left.y) > 1) {
    const sx = Math.max(-500, Math.min(500, left.x))
    const sy = Math.max(-300, Math.min(300, left.y))
    const from = await U.emptySpot(page)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (sx * i) / 10, from.y + (sy * i) / 10)
    await page.mouse.up()
    left = { x: left.x - sx, y: left.y - sy }
  }
  await L.sleep(800)
}

// ---- startup: 10 projects, 60 nodes ----
function startupCanvas(cwd) {
  const projects = Array.from({ length: 10 }, (_, p) => ({ id: `p${p}`, name: `Project ${p}`, folder: cwd, viewport: { x: 40, y: 40, zoom: 0.6 } }))
  const nodes = []
  const edges = []
  // The project on screen: 6 terminals, 6 fake agents, 4 notes, a board, a group. The other nine: 4-5 nodes each.
  nodes.push({ id: 'g0', kind: 'group', title: 'Team', x: 0, y: 0, width: 1560, height: 760, parentId: null, worktree: null, projectId: 'p0' })
  for (let i = 0; i < 6; i++) nodes.push({ id: `t${i}`, kind: 'terminal', title: `term ${i}`, x: 20 + (i % 3) * 500, y: 60 + Math.floor(i / 3) * 340, width: 480, height: 300, parentId: 'g0', cwd, projectId: 'p0' })
  for (let i = 0; i < 6; i++) {
    nodes.push({ id: `a${i}`, kind: 'claude', title: `agent ${i}`, x: 1600 + (i % 3) * 500, y: Math.floor(i / 3) * 340, width: 480, height: 300, parentId: null, cwd, projectId: 'p0', prompt: 'idle', sessionId: null, transcriptPath: null, after: [] })
    if (i) edges.push({ id: `ea${i}`, from: 'a0', to: `a${i}`, kind: i % 2 ? 'opened' : 'link' })
  }
  for (let i = 0; i < 4; i++) nodes.push({ id: `n${i}`, kind: 'sticky', title: `Note ${i}`, text: `## Note ${i}\n- [ ] one\n- [x] two`, x: i * 320, y: 820, width: 300, height: 220, parentId: null, projectId: 'p0' })
  nodes.push({ id: 'w0', kind: 'whiteboard', title: 'Board', shapes: Array.from({ length: 40 }, (_, k) => ({ type: 'rect', color: '#49c2c9', size: 2, x1: k * 7, y1: k * 5, x2: k * 7 + 50, y2: k * 5 + 30 })), x: 1400, y: 820, width: 500, height: 360, parentId: null, projectId: 'p0' })
  let left = 60 - nodes.length
  for (let p = 1; p < 10; p++) {
    const count = Math.round(left / (10 - p))
    left -= count
    for (let i = 0; i < count; i++) {
      const kind = i % 3 === 0 ? 'claude' : i % 3 === 1 ? 'terminal' : 'sticky'
      const base = { id: `p${p}n${i}`, title: `p${p} ${kind} ${i}`, x: (i % 3) * 500, y: Math.floor(i / 3) * 340, width: 480, height: 300, parentId: null, projectId: `p${p}` }
      if (kind === 'claude') nodes.push({ ...base, kind, cwd, prompt: 'idle', sessionId: null, transcriptPath: null, after: [] })
      else if (kind === 'terminal') nodes.push({ ...base, kind, cwd })
      else nodes.push({ ...base, kind, text: 'a note' })
    }
  }
  return { version: 3, projects, activeProjectId: 'p0', viewport: projects[0].viewport, nodes, edges, closed: [] }
}

/**
 * What the window reports about its start, read after the fact: when the page began loading, when the canvas drew
 * the project's nodes, when every terminal on screen had its first rows. Absolute times (ms since the epoch).
 */
const STARTUP_MARKS = () => {
  const nav = performance.getEntriesByType('navigation')[0]
  const o = performance.timeOrigin
  const mark = (n) => performance.getEntriesByName(n)[0]?.startTime
  return { origin: o, domContentLoaded: o + (nav?.domContentLoadedEventEnd ?? 0), scriptStart: o + (nav?.domInteractive ?? 0), canvasMark: mark('pb-canvas') !== undefined ? o + mark('pb-canvas') : null }
}

async function startupOnce(profile, expectNodes, label) {
  const t0 = Date.now()
  const app = await L.launch({ profile })
  const { page } = app
  // Usable: every node of the project on screen drawn, every terminal on screen with rows, and a frame after.
  const usable = await page.evaluate(async (want) => {
    const t = performance.now()
    while (performance.now() - t < 60000) {
      const nodes = document.querySelectorAll('.react-flow__node').length
      const terms = document.querySelectorAll('.react-flow__node-terminal, .react-flow__node-claude').length
      const rows = document.querySelectorAll('.react-flow__node .xterm-rows').length
      if (nodes >= want && rows >= terms) break
      await new Promise((r) => requestAnimationFrame(r))
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return performance.timeOrigin + performance.now()
  }, expectNodes)
  const marks = await page.evaluate(STARTUP_MARKS)
  const r = {
    label,
    usableMs: Math.round(usable - t0),
    pageStartMs: Math.round(marks.origin - t0),
    scriptsLoadedMs: Math.round(marks.scriptStart - t0),
    domLoadedMs: Math.round(marks.domContentLoaded - t0)
  }
  // Agents settled, so the next start finds the same sessions to adopt.
  await L.waitFor('agents idle', async () => {
    const s = await L.statuses(page)
    return Object.values(s).filter((x) => x === 'idle').length >= 6
  }, 90000).catch(() => {})
  return { app, r }
}

async function startupScenario() {
  const cwd = L.workDir('r2perf-startup')
  const profile = L.newProfile({ claudeCommand: `node "${FAKE}"`, notifications: 'off', sound: 'off', usageSource: 'off', ...(SHELL ? { shell: SHELL } : {}) })
  const doc = startupCanvas(cwd)
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
  const onScreen = doc.nodes.filter((n) => n.projectId === 'p0').length
  const out = { cold: [], warm: [] }
  try {
    // First launch: no host, every session started (the profile's first ever start).
    let { app, r } = await startupOnce(profile, onScreen, 'first')
    out.first = r
    console.log(JSON.stringify(r))
    await L.sleep(1500)
    for (let i = 0; i < 3; i++) {
      // Warm: the app quits leaving its sessions running in the host; the next start adopts them.
      await app.quitLeavingSessions()
      await L.sleep(1500)
      ;({ app, r } = await startupOnce(profile, onScreen, 'warm'))
      out.warm.push(r)
      console.log(JSON.stringify(r))
      await L.sleep(1500)
      // Cold: the host is stopped too, so every session starts again under its saved output.
      await app.quitLeavingSessions()
      L.stopHostOf(profile)
      await L.sleep(2000)
      ;({ app, r } = await startupOnce(profile, onScreen, 'cold'))
      out.cold.push(r)
      console.log(JSON.stringify(r))
      await L.sleep(1500)
    }
    await app.quit().catch(() => {})
    const sum = (rs) => Object.fromEntries(['usableMs', 'pageStartMs', 'scriptsLoadedMs', 'domLoadedMs'].map((k) => [k, median(rs.map((x) => x[k]))]))
    out.summary = { cold: sum(out.cold), warm: sum(out.warm) }
  } finally {
    L.cleanup(profile)
  }
  return out
}

/**
 * What a run started and may have left behind: a host that outlived a timed-out quit, and the fake agents and load
 * scripts its shells ran (from this copy of the app only). Runs here go one at a time, so nothing else matches.
 */
function sweep() {
  const here = path.resolve(__dirname, '..', '..').replace(/'/g, "''")
  const ps = [
    `$here = '${here}'.ToLower() + '\\'`,
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='node.exe'\" | Where-Object {",
    '  $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Replace([char]47, [char]92).ToLower().Contains($here) -and',
    "  ($_.CommandLine -match 'sessionHost\\.js|claude-load\\.cjs|fake-claude\\.cjs')",
    '} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('\n')
  try {
    require('node:child_process').execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true, timeout: 30000 })
  } catch {}
}

async function main() {
  const [scenario, file] = process.argv.slice(2)
  const fn = { switch: switchScenario, ticks: ticksScenario, startup: startupScenario }[scenario]
  if (!fn) throw new Error('scenario: switch | ticks | startup')
  sweep()
  let out
  try {
    out = await fn()
  } finally {
    sweep()
  }
  console.log('\nSUMMARY', JSON.stringify(out.summary ?? Object.fromEntries(Object.entries(out).filter(([, v]) => v && v.busy).map(([k, v]) => [k, { task: v.busy['Task%'], script: v.busy['Script%'], gpu: v.cpu?.['gpu-process'], rend: v.cpu?.renderer }]))))
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2))
}

if (require.main === module) main().catch((e) => {
  console.error(e)
  process.exit(1)
})
module.exports = { median }
