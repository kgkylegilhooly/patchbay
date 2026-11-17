'use strict'
// An agent's patchbay send to a Git Bash terminal just after it was resized, as when someone drags its edge or opens
// the focus view. Git Bash dropped the first letter of these. No Claude runs: a note stands in for the agent.
// Run: node test/acceptance/send-after-resize.cjs [--packaged]
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const L = require('./lib.cjs')
const c = L.checker()

function rpc(profile, node, verb, args) {
  const secret = fs.readFileSync(path.join(profile, 'secret'), 'utf8')
  const { port } = JSON.parse(fs.readFileSync(path.join(profile, 'control', 'endpoint.json'), 'utf8'))
  const body = JSON.stringify({ verb, args })
  const token = crypto.createHmac('sha256', secret).update(node).digest('hex')
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-patchbay-node': node, authorization: `Bearer ${token}` } }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function main() {
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const cwd = L.workDir('probe-send')
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify({
    version: 3, projects: [{ id: 'p1', name: 'P', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p1', viewport: { x: 0, y: 0, zoom: 0.8 },
    nodes: [{ id: 'agent', kind: 'sticky', title: 'agent', x: 0, y: 400, width: 200, height: 100, parentId: null, projectId: 'p1', text: 'stands in for an agent' }],
    edges: [], closed: []
  }))
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  const page = app.page
  try {
    await L.openNode(page, { ...L.terminal('t', cwd, 0, 0), projectId: 'p1' })
    await page.evaluate(() => window.patchbay.dispatch({ op: 'addEdge', edge: { id: 'l', from: 'agent', to: 't', kind: 'link' } }))
    await L.waitFor('prompt', async () => (await L.snapshot(page, 't')).includes('$'), 20000)
    await L.sleep(1500)
    let lost = 0
    const N = Number(process.env.N || 12)
    for (let i = 0; i < N; i++) {
      // A resize, as from the person dragging the node's edge or opening the focus view.
      await page.evaluate((w) => window.patchbay.resize('t', w, 30), i % 2 ? 90 : 100)
      await L.sleep(300)
      const r = await rpc(profile, 'agent', 'send', { node: 't', text: `echo sent-${i}` })
      if (r.status !== 200) console.log('send refused', r.json)
      await L.sleep(900)
    }
    const s = await L.snapshot(page, 't')
    for (let i = 0; i < N; i++) if (!new RegExp(`[\\r\\n](\\x1b\\[\\?2004l)?sent-${i}(\\x1b\\[K)?\\r?\\n`).test(s)) lost++
    c.check(`Every send after a resize arrives whole (${N} tries)`, lost === 0, { lost, errors: (s.match(/bash: [^\r\n]*: command not found/g) ?? []).slice(0, 3) })
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
