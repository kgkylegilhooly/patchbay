'use strict'
// Runs another check as if on a modest PC: it and everything it starts (Patchbay, its host, the agents and their shells)
// share only the first few CPU cores, which Windows makes every child inherit. The cores are still this PC's, so for a
// slower processor too, PB_PERF_SLOW slows the window's CPU in the checks that read it.
//
// Run: node test/acceptance/lowend.cjs <cores> <check.cjs> [its arguments]
//   e.g. node test/acceptance/lowend.cjs 2 test/acceptance/perf-tabs.cjs
const { spawn } = require('node:child_process')
const path = require('node:path')

const [coresText, script, ...rest] = process.argv.slice(2)
const cores = Number(coresText)
if (!cores || !script) {
  console.error('Usage: node test/acceptance/lowend.cjs <cores> <check.cjs> [its arguments]')
  process.exit(2)
}
const mask = ((1n << BigInt(cores)) - 1n).toString(16).toUpperCase()
console.log(`LOW-END: ${cores} core${cores === 1 ? '' : 's'} (affinity ${mask}) for ${path.basename(script)}`)
// start /affinity sets it as the process is created, so nothing it starts escapes it.
const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', '/wait', '/affinity', mask, process.execPath, script, ...rest], { stdio: 'inherit', env: { ...process.env, PB_LOW_END_CORES: String(cores) } })
child.on('exit', (code) => process.exit(code ?? 1))
