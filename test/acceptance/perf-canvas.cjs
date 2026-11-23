'use strict'
// Canvas perf, before/after: runs rperf.cjs (the heavy 44-node scene) PB_PC_RUNS times (default 3), each in its own
// quiet off-screen launch, and prints the median of each number per scenario. Build first (npx electron-vite build).
//
//   node test/acceptance/perf-canvas.cjs <tag>                          writes .superpowers/accept/perf-canvas/<tag>.json
//   node test/acceptance/perf-canvas.cjs base=<copy> after "layer|x.css"
//
// With several variants the runs take turns (base, after, base, after...), so a PC whose load drifts while it runs
// (other agents building and testing) weighs on each the same. A variant is <tag>[=<app folder>][|<css file>]: the app
// folder holds another build (an archive copy of main, say; default this one), the css file is injected as an A/B.
//
// Terminals run cmd.exe unless PB_RP_SHELL says otherwise (see rperf.cjs).
// Env: PB_PC_RUNS (3)  PB_RP_ONLY (scenarios; default the canvas ones below)  PB_PC_DIR (where results go)
//      and any PB_RP_* for rperf.cjs.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')

const variants = (process.argv.length > 2 ? process.argv.slice(2) : ['run']).map((arg) => {
  const [head, css] = arg.split('|')
  const [tag, root] = head.split('=')
  return { tag, root: root ? path.resolve(root) : path.resolve(__dirname, '..', '..'), css: css ? fs.readFileSync(css, 'utf8') : undefined }
})
const RUNS = Number(process.env.PB_PC_RUNS || 3)
const ONLY = process.env.PB_RP_ONLY || 'quiet,output,drag-terminal,drag-note,pan,zoom,output-far,pan-far'
const dir = process.env.PB_PC_DIR || path.join(L.workRoot, 'perf-canvas')
fs.mkdirSync(dir, { recursive: true })

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2] : +((s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1)
}

/** The numbers compared, per scenario, from one rperf result. */
function pick(r) {
  return {
    fps: r.frames.fps,
    p95: r.frames.p95,
    over33: r.frames.over33,
    'task%': r.busy['Task%'],
    'script%': r.busy['Script%'],
    'layout%': r.busy['Layout%'],
    'style%': r.busy['RecalcStyle%'],
    gpu: r.cpu?.['gpu-process'],
    renderer: r.cpu?.renderer,
    ...(r.react ? { commitsPerS: r.react.commitsPerS, renderMs: r.react.renderMs } : {})
  }
}

const runsOf = Object.fromEntries(variants.map((v) => [v.tag, []]))
for (let i = 0; i < RUNS; i++) {
  for (const { tag, root, css } of variants) {
    const out = path.join(dir, `${tag}-${i}.json`)
    const t0 = Date.now()
    // Each build runs its own copy of the harness, kept the same as this one.
    const harness = path.join(root, 'test', 'acceptance', 'rperf.cjs')
    if (harness !== path.join(__dirname, 'rperf.cjs')) fs.copyFileSync(path.join(__dirname, 'rperf.cjs'), harness)
    const env = { ...process.env, PB_RP_SHELL: process.env.PB_RP_SHELL ?? 'cmd', PB_RP_OUT: out, PB_RP_ONLY: ONLY, PB_RP_TAG: `${tag}-${i}` }
    if (css) env.PB_RP_CSS = css
    const r = spawnSync(process.execPath, [harness], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20 * 60_000 })
    fs.writeFileSync(path.join(dir, `${tag}-${i}.log`), `${r.stdout}\n${r.stderr}`)
    if (r.status !== 0) {
      console.error(`${tag} run ${i} failed (${r.status}):\n${r.stderr.slice(-2000)}`)
      continue
    }
    runsOf[tag].push(JSON.parse(fs.readFileSync(out, 'utf8')))
    console.log(`${tag} run ${i} done in ${Math.round((Date.now() - t0) / 1000)} s`)
  }
}

const scenarios = ONLY.split(',')
for (const { tag } of variants) {
  const runs = runsOf[tag]
  const table = {}
  for (const s of scenarios) {
    const picked = runs.filter((r) => r[s]).map((r) => pick(r[s]))
    if (!picked.length) continue
    table[s] = Object.fromEntries(Object.keys(picked[0]).map((k) => [k, median(picked.map((p) => p[k]))]))
  }
  fs.writeFileSync(path.join(dir, `${tag}.json`), JSON.stringify({ tag, runs: runs.length, scene: runs[0]?.scene, medians: table }, null, 2))
  console.log(`\n${tag}: median of ${runs.length} runs`)
  console.table(table)
}
