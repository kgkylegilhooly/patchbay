'use strict'
// Before/after for r2perf.cjs: runs one scenario PB_R2_RUNS times (default 3) per build, the builds taking turns
// (a, b, c, a, b, c, ...) so a PC whose load drifts weighs on each the same, and prints the median of every summary
// number per build as a markdown table.
//
//   node test/acceptance/r2perf-ab.cjs <switch|ticks|startup> <tag>=<app folder> [<tag>=<app folder> ...]
//
// An app folder holds a built copy of the app (`git archive <commit> | tar -x -C <dir>`, then `npx electron-vite build`
// in it); `.` is this one. Results go to .superpowers/accept/r2perf/<scenario>-<tag>-<n>.json.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const { median } = require('./r2perf.cjs')

const [scenario, ...specs] = process.argv.slice(2)
const variants = specs.map((s) => {
  const [tag, root = '.'] = s.split('=')
  return { tag, root: path.resolve(root) }
})
const RUNS = Number(process.env.PB_R2_RUNS || 3)
const dir = path.join(L.workRoot, 'r2perf')
fs.mkdirSync(dir, { recursive: true })

/** The numbers a run is judged by: its summary, or for ticks each measured part's busy, CPU and render counts. */
function numbers(r) {
  if (r.summary && scenario !== 'startup') return r.summary
  if (scenario === 'startup') return Object.fromEntries(['cold', 'warm'].flatMap((k) => Object.entries(r.summary[k]).map(([n, v]) => [`${k} ${n}`, v])))
  const out = {}
  for (const [name, v] of Object.entries(r)) {
    if (!v || !v.busy) continue
    out[`${name}: Task %`] = v.busy['Task%']
    out[`${name}: Script %`] = v.busy['Script%']
    out[`${name}: GPU % of a core`] = v.cpu?.['gpu-process']
    out[`${name}: window % of a core`] = v.cpu?.renderer
    if (v.react) {
      out[`${name}: React commits`] = v.react.commits
      for (const c of ['Row', 'SidebarView', 'CableEdge', 'NodeWrapper', 'EdgeWrapper']) out[`${name}: ${c} renders`] = v.react.byName[c]?.renders ?? 0
    }
  }
  return out
}

const runs = Object.fromEntries(variants.map((v) => [v.tag, []]))
for (let i = 0; i < RUNS; i++) {
  for (const { tag, root } of variants) {
    const harness = path.join(root, 'test', 'acceptance', 'r2perf.cjs')
    // Each build runs this copy of the harness (and rperf.cjs, which it uses), so all are measured the same way.
    for (const f of ['r2perf.cjs', 'rperf.cjs']) if (path.join(root, 'test', 'acceptance', f) !== path.join(__dirname, f)) fs.copyFileSync(path.join(__dirname, f), path.join(root, 'test', 'acceptance', f))
    const out = path.join(dir, `${scenario}-${tag}-${i}.json`)
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [harness, scenario, out], { env: { ...process.env, PB_RP_SHELL: process.env.PB_RP_SHELL ?? 'cmd' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 25 * 60_000 })
    fs.writeFileSync(out.replace(/\.json$/, '.log'), `${r.stdout}\n${r.stderr}`)
    if (r.status !== 0 || !fs.existsSync(out)) {
      console.error(`${tag} run ${i} failed (${r.status}):\n${(r.stderr || r.stdout).slice(-1500)}`)
      continue
    }
    runs[tag].push(numbers(JSON.parse(fs.readFileSync(out, 'utf8'))))
    console.log(`${tag} run ${i} done in ${Math.round((Date.now() - t0) / 1000)} s`)
  }
}

const keys = [...new Set(Object.values(runs).flatMap((rs) => rs.flatMap((r) => Object.keys(r))))]
const lines = [`| ${scenario} (median of runs) | ${variants.map((v) => `${v.tag} (${runs[v.tag].length})`).join(' | ')} |`, `|---|${variants.map(() => '---:').join('|')}|`]
for (const k of keys) lines.push(`| ${k} | ${variants.map((v) => median(runs[v.tag].map((r) => r[k])) ?? '').join(' | ')} |`)
const table = lines.join('\n')
fs.writeFileSync(path.join(dir, `${scenario}-${variants.map((v) => v.tag).join('-')}.md`), table + '\n')
console.log('\n' + table)
