'use strict'
// Claude Code runs this to draw its status line. It reports the usage numbers to Patchbay, then draws whatever the
// owner's own status line draws. Whatever goes wrong, it exits 0 and can never block or disturb Claude.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')

const REPORT_LIMIT_MS = 300
const FORWARD_LIMIT_MS = 5000
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
/** The fields Patchbay uses, so a large status line input can't reach its size limit. */
const REPORTED = ['session_id', 'cost', 'context_window', 'rate_limits']

function done() {
  process.exit(0)
}

process.on('uncaughtException', done)
process.on('unhandledRejection', done)
setTimeout(done, FORWARD_LIMIT_MS + 500)

function report(raw) {
  return new Promise((resolve) => {
    setTimeout(resolve, REPORT_LIMIT_MS)
    const { PATCHBAY_ENDPOINT_FILE: file, PATCHBAY_NODE_ID: nodeId, PATCHBAY_TOKEN: token } = process.env
    if (!file || !nodeId || !token) return resolve()
    // Read on every call: a restarted app listens on a new port, and sessions must still find it.
    const { port, pid } = JSON.parse(fs.readFileSync(file, 'utf8'))
    // With the app closed there's nobody to tell, and the owner's status line shouldn't wait to find that out.
    if (typeof port !== 'number') return resolve()
    if (typeof pid === 'number') {
      try {
        process.kill(pid, 0)
      } catch (e) {
        if (e.code === 'ESRCH') return resolve()
      }
    }
    const input = JSON.parse(raw)
    const fields = {}
    for (const key of REPORTED) if (input[key] !== undefined) fields[key] = input[key]
    const body = JSON.stringify(fields)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/usage',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-patchbay-node': nodeId,
          authorization: `Bearer ${token}`
        }
      },
      (res) => {
        res.resume()
        res.on('end', resolve)
        res.on('error', resolve)
      }
    )
    req.on('error', resolve)
    req.end(body)
  }).catch(() => {})
}

/** Resolves with what to print. A command that fails or hangs prints nothing rather than half a line. */
function forward(raw) {
  const command = process.env.PATCHBAY_STATUSLINE_FORWARD
  if (!command) return Promise.resolve('')
  return new Promise((resolve) => {
    // Claude Code runs status lines through Git Bash where it can, so an owner's command may be written for it.
    const useBash = fs.existsSync(GIT_BASH)
    const child = useBash
      ? spawn(GIT_BASH, ['-c', command], { stdio: 'pipe', windowsHide: true })
      : spawn(command, { shell: true, stdio: 'pipe', windowsHide: true })
    const chunks = []
    const limit = setTimeout(() => {
      resolve('')
      child.kill()
    }, FORWARD_LIMIT_MS)
    child.stdout.on('data', (c) => chunks.push(c))
    child.on('error', () => resolve(''))
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      clearTimeout(limit)
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : '')
    })
    child.stdin.end(raw)
  })
}

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('error', done)
process.stdin.on('end', async () => {
  const raw = Buffer.concat(chunks).toString('utf8')
  const [text] = await Promise.all([forward(raw), report(raw)])
  if (text) process.stdout.write(text, done)
  else done()
})
