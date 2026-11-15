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
  // PB_USE_PACKAGED runs the packaged build in release/ instead of the built dev output.
  const app = await L.launch({ profile, exe: process.env.PB_USE_PACKAGED ? L.packagedExe : undefined })
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
    // A screenshot pasted while the board is selected: a picture made in the page, handed over as a paste would be.
    const page = app.page
    await L.fitView?.(page)
    await page.click('.react-flow__node[data-id="board"] .wb-head .title')
    const passed = await page.evaluate(() => {
      let prevented = null
      const watch = (e) => (prevented = e.defaultPrevented)
      window.addEventListener('keydown', watch)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true }))
      window.removeEventListener('keydown', watch)
      return prevented
    })
    c.check('Ctrl+V on the canvas, with no terminal to paste into, is left for the page', passed === false, passed)
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 240
      canvas.height = 120
      const g = canvas.getContext('2d')
      g.fillStyle = '#2f9e5b'
      g.fillRect(0, 0, 240, 120)
      g.fillStyle = '#fff'
      g.font = '28px sans-serif'
      g.fillText('PASTED', 60, 72)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
      const data = new DataTransfer()
      data.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    const pictured = await L.waitFor('the picture on the board', async () => (await L.doc(page)).nodes.find((n) => n.id === 'board').shapes.find((s) => s.type === 'image'), 10000).catch(() => null)
    c.check('A pasted picture is added to the selected board, fitted inside it', pictured && pictured.width === 240 && pictured.height === 120 && /^[0-9a-f]{64}\.png$/.test(pictured.file), pictured)
    c.check('Its file is kept in app data, not in the canvas file', pictured && fs.existsSync(path.join(profile, 'whiteboards', 'images', pictured.file)) && !fs.readFileSync(path.join(profile, 'canvas.json'), 'utf8').includes('base64'))
    const shown = await L.waitFor('the picture drawn', () => page.$('.react-flow__node[data-id="board"] .wb-svg image[href^="data:image/png"]'), 5000).catch(() => null)
    c.check('The board draws it', !!shown)
    const again = await rpc(profile, 'agent', 'whiteboard', { node: 'board' })
    const svg = again.json.result?.svg ? fs.readFileSync(again.json.result.svg, 'utf8') : ''
    const png2 = again.json.result?.image ? fs.readFileSync(again.json.result.image) : null
    c.check('An agent\'s export includes the picture', svg.includes('<image href="data:image/png;base64,') && again.json.result.shapes.image === 1 && png2 && png2.length > png.length, { shapes: again.json.result?.shapes, bytes: png2?.length })
    if (process.env.PB_KEEP_EXPORT && png2) fs.writeFileSync(process.env.PB_KEEP_EXPORT.replace(/\.png$/, '-picture.png'), png2)
    // The profile goes when this ends, so the picture is kept elsewhere for looking at, when asked.
    if (png && process.env.PB_KEEP_EXPORT) fs.copyFileSync(r.image, process.env.PB_KEEP_EXPORT)
    // The agent sketches back: boxes and arrows, laid out for it, below what's there, with the board grown to show it.
    const diagram = {
      title: 'Checkout, as I understand it',
      boxes: [{ id: 'cart', label: 'Cart page' }, { id: 'api', label: 'Orders API' }, { id: 'pay', label: 'Payment\nprovider', color: 'blue' }, { id: 'mail', label: 'Receipt email', color: 'green' }],
      arrows: [{ from: 'cart', to: 'api', label: 'POST /orders' }, { from: 'api', to: 'pay', label: 'charge' }, { from: 'api', to: 'mail' }]
    }
    const sizeBefore = (await L.doc(page)).nodes.find((n) => n.id === 'board')
    const drew = await rpc(profile, 'agent', 'draw', { node: 'board', diagram: JSON.stringify(diagram) })
    const boardAfter = (await L.doc(page)).nodes.find((n) => n.id === 'board')
    c.check('A linked agent draws a diagram on the board', drew.status === 200 && drew.json.result?.added === 14, drew.json)
    c.check('The board grows to show it', boardAfter.height > sizeBefore.height, [sizeBefore.height, boardAfter.height])
    const notice = await L.waitFor('the drawn-by notice', () => page.$eval('.react-flow__node[data-id="board"] .wb-drawn', (n) => n.textContent), 3000).catch(() => '')
    c.check('The board says which agent drew on it', /agent drew 14 shapes/.test(notice), notice)
    if (process.env.PB_SHOTS) {
      await L.fitView?.(page)
      await L.sleep(400)
      const shot = await page.$('.react-flow__node[data-id="board"]')
      await shot.screenshot({ path: path.join(process.env.PB_SHOTS, 'board-drawn.png') })
    }
    const refusedDraw = await rpc(profile, 'stranger', 'draw', { node: 'board', diagram: JSON.stringify(diagram) })
    c.check('A node that is not linked cannot draw on it', refusedDraw.status === 400, refusedDraw.json)
    const badDraw = await rpc(profile, 'agent', 'draw', { node: 'board', diagram: '{"boxes": [{"id": "a"}], "arrows": [{"from": "a", "to": "b"}]}' })
    c.check('A diagram with a mistake is refused with what to fix', badDraw.status === 400 && /Arrow 1/.test(badDraw.json.error), badDraw.json)
    await page.click('.react-flow__node[data-id="board"] .wb-drawn .btn')
    const undone = await L.waitFor('the drawing taken away', async () => (await L.doc(page)).nodes.find((n) => n.id === 'board').shapes.length === boardAfter.shapes.length - 14, 3000).catch(() => false)
    c.check('Undo takes away what the agent drew, and nothing else', undone && !(await page.$('.wb-drawn')))

    // Text already on the board changes in place: double-click it with the select tool and type.
    await page.click('.react-flow__node[data-id="board"] [aria-label="Select and move"]')
    const surface = await page.$('.react-flow__node[data-id="board"] .wb-surface')
    const box = await surface.boundingBox()
    const scale = box.width / (await surface.evaluate((el) => el.offsetWidth))
    const word = (await L.doc(page)).nodes.find((n) => n.id === 'board').shapes.find((s) => s.type === 'text' && s.text === 'Checkout')
    await page.mouse.click(box.x + (word.x + 20) * scale, box.y + (word.y + 10) * scale, { count: 2 })
    await page.waitForSelector('.react-flow__node[data-id="board"] .wb-type', { timeout: 3000 }).catch(() => {})
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await page.keyboard.type('Checkout v2')
    await page.keyboard.press('Enter')
    const renamed = await L.waitFor('the text changed', async () => (await L.doc(page)).nodes.find((n) => n.id === 'board').shapes.some((s) => s.type === 'text' && s.text === 'Checkout v2'), 3000).catch(() => false)
    c.check('Double-clicking text with the select tool changes it in place', renamed)

    // Ctrl+D copies what's selected.
    const before = (await L.doc(page)).nodes.find((n) => n.id === 'board').shapes.length
    await page.mouse.click(box.x + (word.x + 20) * scale, box.y + (word.y + 10) * scale)
    await page.keyboard.down('Control')
    await page.keyboard.press('d')
    await page.keyboard.up('Control')
    const copied = await L.waitFor('the copy', async () => (await L.doc(page)).nodes.find((n) => n.id === 'board').shapes.length === before + 1, 3000).catch(() => false)
    c.check('Ctrl+D copies the selected shape', copied)

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
