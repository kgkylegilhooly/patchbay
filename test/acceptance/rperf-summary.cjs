'use strict'
// Medians across rperf.cjs runs: node rperf-summary.cjs <tag>=<a.json,b.json,c.json> [<tag>=...]
// Prints one markdown table with a column per tag, for the numbers the terminal work is judged by.
const fs = require('node:fs')

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const ROWS = [
  ['output: window Task %', (r) => r.output?.busy['Task%']],
  ['output: Script %', (r) => r.output?.busy['Script%']],
  ['output: GPU process, % of a core', (r) => r.output?.cpu?.['gpu-process']],
  ['output: window process, % of a core', (r) => r.output?.cpu?.renderer],
  ['output: xterm row changes /s', (r) => r.output?.rowMutationsPerS],
  ['typing: key to echo p50 ms', (r) => r.typing?.keys?.p50],
  ['typing: key to echo p95 ms', (r) => r.typing?.keys?.p95],
  ['typing-split: round trip p50 ms', (r) => r['typing-split']?.roundTrip?.p50],
  ['typing-split: echo arrived to drawn p50 ms', (r) => r['typing-split']?.draw?.p50],
  ['typing-split: echo arrived to drawn p95 ms', (r) => r['typing-split']?.draw?.p95],
  ['drag-terminal: Task %', (r) => r['drag-terminal']?.busy['Task%']],
  ['drag-terminal: Script %', (r) => r['drag-terminal']?.busy['Script%']],
  ['drag-note: Script %', (r) => r['drag-note']?.busy['Script%']],
  ['switch p1→p2 (6 terminals) ms', (r) => median([r['switch-project']?.switchMs?.[0], r['switch-project']?.switchMs?.[2]])],
  ['switch p2→p1 (27 terminals) ms', (r) => median([r['switch-project']?.switchMs?.[1], r['switch-project']?.switchMs?.[3]])],
  ['switch: worst frame ms', (r) => r['switch-project']?.frames.worst],
  ['switch: frames over 50 ms', (r) => r['switch-project']?.frames.over50],
  ['switch: Script %', (r) => r['switch-project']?.busy['Script%']],
  ['pan: Task %', (r) => r.pan?.busy['Task%']],
  ['pan: GPU process %', (r) => r.pan?.cpu?.['gpu-process']],
  ['zoom: Task %', (r) => r.zoom?.busy['Task%']],
  ['overview output: Task %', (r) => r['output-far']?.busy['Task%']],
  ['overview output: GPU process %', (r) => r['output-far']?.cpu?.['gpu-process']],
  ['overview output: xterm row changes /s', (r) => r['output-far']?.rowMutationsPerS],
  ['overview pan: Task %', (r) => r['pan-far']?.busy['Task%']],
  ['quiet: Task %', (r) => r.quiet?.busy['Task%']]
]

const sets = process.argv.slice(2).map((arg) => {
  const [tag, files] = arg.split('=')
  return { tag, runs: files.split(',').filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).filter((r) => r.output) }
})
console.log(`| Measure (median of runs) | ${sets.map((s) => `${s.tag} (n=${s.runs.length})`).join(' | ')} |`)
console.log(`|---|${sets.map(() => '---:').join('|')}|`)
for (const [name, get] of ROWS) {
  const cells = sets.map((s) => {
    const m = median(s.runs.map(get))
    return m === null ? '–' : String(Math.round(m * 10) / 10)
  })
  console.log(`| ${name} | ${cells.join(' | ')} |`)
}
