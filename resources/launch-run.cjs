'use strict'
// Runs one launch.json configuration in a run node, from the plan Patchbay wrote when Run was clicked. Running it
// directly, with no shell between, means its arguments and environment arrive exactly as launch.json gave them.
//
// Usage: node launch-run.cjs <plan.json>
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function fail(message) {
  process.stderr.write(`\x1b[31mPatchbay: ${message}\x1b[0m\r\n`)
  process.exit(1)
}

/** Finds a program the way a Windows shell would, trying each of PATHEXT on each PATH folder. */
function locate(file, env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const tries = (base) => (path.extname(base) ? [base] : [base, ...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)])
  const found = (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (file.includes('/') || file.includes('\\')) return tries(file).find(found) || null
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
  for (const dir of (env[pathKey] || '').split(path.delimiter).filter(Boolean)) {
    const hit = tries(path.join(dir, file)).find(found)
    if (hit) return hit
  }
  return null
}

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const env = { ...process.env }
for (const [k, v] of Object.entries(plan.env || {})) {
  if (v === null) delete env[k]
  else env[k] = v
}
if (!fs.existsSync(plan.cwd)) fail(`The folder ${plan.cwd} doesn't exist.`)
const program = locate(plan.file, env)
if (!program) fail(`Couldn't find ${plan.file} on PATH.`)

let file = program
let args = plan.args
let verbatim = false
if (/\.(cmd|bat)$/i.test(program)) {
  // Windows runs these only through cmd, whose quoting can't carry every character safely.
  const unsafe = args.find((a) => /["%\r\n]/.test(a))
  if (unsafe !== undefined) fail(`${path.basename(program)} runs through cmd, which can't pass ${JSON.stringify(unsafe)} safely.`)
  file = env.ComSpec || 'cmd.exe'
  args = ['/d', '/s', '/c', `"${[program, ...plan.args].map((a) => `"${a}"`).join(' ')}"`]
  verbatim = true
}

process.stdout.write(`\x1b[2m> ${[plan.file, ...plan.args].join(' ')}\x1b[0m\r\n`)
const child = spawn(file, args, { cwd: plan.cwd, env, stdio: 'inherit', windowsVerbatimArguments: verbatim })
child.on('error', (e) => fail(e.message))
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
