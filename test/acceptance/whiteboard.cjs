'use strict'
// A whiteboard exported by an agent linked to it, through the real control server and the real app window, which
// draws the PNG. A sticky note stands in for the agent, so no Claude runs and it spends no quota.
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(3 * 60_000)

function seed(profile) {
  const at = (id, kind, x, extra) => ({ id, kind, title: id, x, y: 0, width: 300, height: 200, parentId: null, projectId: 'p1', ...extra })
  const doc = {
    version: 3,
    projects: [{ id: 'p1', name: 'Boards', folder: '', viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 0.8 },
    nodes: [
      at('agent', 'sticky', 0, { text: 'stands in for an agent' }),
      at('stranger', 'sticky', 0, { y: 260, text: 'not linked' }),
      at('board', 'whiteboard', 400, {
        width: 500,
        height: 360,
        shapes: [
          { type: 'rect', color: '#1f1f22', size: 4, x1: 20, y1: 20, x2: 200, y2: 120 },
          { type: 'text', color: '#2f6fd6', size: 4, x: 40, y: 50, text: 'Checkout' },
          { type: 'pen', color: '#d64545', size: 8, points: [20, 200, 120, 240, 220, 200] }
        ]
      })
    ],
    edges: [{ id: 'l', from: 'agent', to: 'board', kind: 'link' }],
    closed: []
  }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
}

/** Calls a verb as a node, the way the patchbay command does. */
function rpc(profile, node, verb, args) {
  const secret = fs.readFileSync(path.join(profile, 'secret'), 'utf8')
  const { port } = JSON.parse(fs.readFileSync(path.join(profile, 'control', 'endpoint.json'), 'utf8'))
  const body = JSON.stringify({ verb, args })
  const token = crypto.createHmac('sha256', secret).update(node).digest('hex')
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-patchbay-node': node, authorization: `Bearer ${token}` } },
      (res) => {
        const chunks = []
        res.on('data', (d) => chunks.push(d))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function main() {
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  seed(profile)
  const app = await L.launch({ profile })
  try {
    await L.waitFor('the control endpoint', () => fs.existsSync(path.join(profile, 'control', 'endpoint.json')), 20000)
    const out = await rpc(profile, 'agent', 'whiteboard', { node: 'board' })
    const r = out.json.result ?? {}
    const png = r.image && fs.existsSync(r.image) ? fs.readFileSync(r.image) : null
    c.check('A linked node exports the board as a PNG the window drew', out.status === 200 && png && png.subarray(1, 4).toString() === 'PNG', out.json)
    c.check('The PNG is the paper size, which is the node less its header, toolbar and margins', png && png.readUInt32BE(16) === 486 && png.readUInt32BE(20) === 276, png && [png.readUInt32BE(16), png.readUInt32BE(20)])
    c.check('The SVG is saved beside it, with the words on the board', r.svg && fs.readFileSync(r.svg, 'utf8').includes('>Checkout<'))
    c.check('The reply lists what is on the board', JSON.stringify(r.shapes) === JSON.stringify({ rect: 1, text: 1, pen: 1 }) && r.texts?.[0] === 'Checkout', r)
    const refused = await rpc(profile, 'stranger', 'whiteboard', { node: 'board' })
    c.check('A node that is not linked is refused', refused.status === 400 && /isn't linked to you/.test(refused.json.error), refused.json)
    const who = await rpc(profile, 'agent', 'whoami', {})
    c.check('whoami lists the linked board', /"board" \(whiteboard, node board\)/.test(who.json.result?.text ?? ''), who.json.result?.text)
    // The profile goes when this ends, so the picture is kept elsewhere for looking at, when asked.
    if (png && process.env.PB_KEEP_EXPORT) fs.copyFileSync(r.image, process.env.PB_KEEP_EXPORT)
    c.check('No page errors in the app window', app.problems.length === 0, app.problems.slice(0, 3))
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
