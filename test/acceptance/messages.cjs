'use strict'
// A message between two nodes shows on the cable joining them, and the palette finds a note by its text. Two
// terminals stand in for agents, so no Claude runs and it spends no quota.
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')

const c = L.checker()
U.watchdog(3 * 60_000)
const SHOTS = process.env.PB_SHOTS

function seed(profile, cwd) {
  const term = (id, x) => ({ id, kind: 'terminal', title: id === 'lead' ? 'Lead' : 'Worker', x, y: 0, width: 460, height: 280, parentId: null, cwd, projectId: 'p1' })
  const doc = {
    version: 3,
    projects: [{ id: 'p1', name: 'Team', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 340, y: 120, zoom: 0.85 },
    nodes: [
      term('lead', 0),
      term('dev', 640),
      { id: 'board', kind: 'sticky', title: 'Note', text: '## Release checklist\n- [ ] bump the version', x: 0, y: 360, width: 280, height: 200, parentId: null, projectId: 'p1' }
    ],
    edges: [
      { id: 'cable', from: 'lead', to: 'dev', kind: 'link' },
      { id: 'to-note', from: 'lead', to: 'board', kind: 'link' }
    ],
    closed: []
  }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
}

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
  const cwd = L.workDir('messages')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  seed(profile, cwd)
  // PB_USE_PACKAGED runs the packaged build in release/ instead of the built dev output.
  const app = await L.launch({ profile, exe: process.env.PB_USE_PACKAGED ? L.packagedExe : undefined })
  const page = app.page
  try {
    for (const id of ['lead', 'dev']) await L.waitFor(`the ${id} shell`, async () => /\$|>/.test(await L.snapshot(page, id)), 30000)
    const sent = await rpc(profile, 'lead', 'send', { node: 'dev', text: 'echo hello-from-lead' })
    c.check('The lead sends the worker a message', sent.status === 200 && sent.json.result?.delivered === true, sent.json)
    const lit = await L.waitFor('the pulse', () => page.$('.react-flow__edge[data-id="cable"] .cable-message'), 3000).catch(() => null)
    c.check('The cable between them shows the message', !!lit)
    const way = await page.$eval('.react-flow__edge[data-id="cable"] animateMotion', (m) => m.getAttribute('keyPoints')).catch(() => null)
    c.check('It runs from the sender to the receiver', way === '0;1', way)
    await L.sleep(350)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'message-pulse.png') })
    await L.waitFor('the pulse to end', async () => !(await page.$('.cable-message')), 5000).catch(() => {})
    c.check('The pulse goes away on its own', !(await page.$('.cable-message')))
    const back = await rpc(profile, 'dev', 'send', { node: 'lead', text: 'echo done' })
    const backWay = await L.waitFor('the reply pulse', () => page.$eval('.react-flow__edge[data-id="cable"] animateMotion', (m) => m.getAttribute('keyPoints')), 3000).catch(() => null)
    c.check('A reply runs the other way down the same cable', back.status === 200 && backWay === '1;0', backWay)
    await L.waitFor('the worker to run it', async () => (await L.snapshot(page, 'dev')).includes('hello-from-lead'), 10000).catch(() => {})
    c.check('The worker got the text', (await L.snapshot(page, 'dev')).includes('hello-from-lead'))

    // Clicking the cable lists what was said along it.
    const middle = await page.$eval('.react-flow__edge[data-id="cable"] .react-flow__edge-interaction', (p) => {
      const at = p.getPointAtLength(p.getTotalLength() / 2)
      const m = p.getScreenCTM()
      return { x: at.x * m.a + m.e, y: at.y * m.d + m.f }
    })
    await page.mouse.click(middle.x, middle.y)
    const log = await L.waitFor('the cable panel', () => page.$$eval('.cable-log li', (lis) => lis.map((li) => li.textContent)), 3000).catch(() => [])
    c.check('A selected cable lists the messages both ways, newest last', log.length === 2 && /Lead to Worker/.test(log[0]) && /echo hello-from-lead/.test(log[0]) && /Worker to Lead/.test(log[1]), log)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cable-log.png') })

    // An agent adds to the person's note: the note says who, and Undo puts it back.
    const added = await rpc(profile, 'lead', 'note', { node: 'board', append: '- [ ] tag the release (Lead)' })
    c.check('A linked agent adds a line to the note', added.status === 200, added.json)
    const footer = await L.waitFor('the change notice', () => page.$eval('.react-flow__node[data-id="board"] .note-edited', (f) => f.textContent), 3000).catch(() => '')
    c.check('The note says which agent changed it', /Changed by Lead/.test(footer), footer)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'note-edited.png') })
    await page.click('.react-flow__node[data-id="board"] .note-edited-undo')
    const restored = await L.waitFor('the note put back', async () => (await L.doc(page)).nodes.find((n) => n.id === 'board').text === '## Release checklist\n- [ ] bump the version', 3000).catch(() => false)
    c.check('Undo puts back the text from before, and the notice goes', restored && !(await page.$('.note-edited')))

    await page.click('.react-flow__pane')
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    await page.waitForSelector('.palette input', { timeout: 5000 })
    await page.keyboard.type('bump the')
    await L.sleep(200)
    const rows = await page.$$eval('.palette li', (lis) => lis.map((li) => li.textContent))
    c.check('The palette finds the note by a phrase in its text, under its first line', rows.length > 0 && /Release checklist/.test(rows[0]) && /Note/.test(rows[0]), rows.slice(0, 3))
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'palette-note.png') })
    c.check('No page errors in the app window', app.problems.length === 0, app.problems.slice(0, 3))

    // An agent changes the note again, and the notice saying so has to outlast a restart.
    await rpc(profile, 'lead', 'note', { node: 'board', append: '- [ ] write the changelog (Lead)' })
    await L.waitFor('the change notice', () => page.$('.react-flow__node[data-id="board"] .note-edited'), 3000).catch(() => null)

    // Quit and open again on the same profile: what the nodes said is still there.
    await app.quit()
    const reopened = await L.launch({ profile, exe: process.env.PB_USE_PACKAGED ? L.packagedExe : undefined })
    try {
      const kept = await reopened.page.evaluate(() => window.patchbay.getMessages())
      c.check('Messages between nodes are still there after Patchbay restarts', kept.some((m) => m.text.includes('hello-from-lead')) && kept.some((m) => m.text.includes('echo done')), kept.map((m) => m.text))
      const again = reopened.page
      const notice = await L.waitFor('the notice after a restart', () => again.$eval('.react-flow__node[data-id="board"] .note-edited', (f) => f.textContent), 10000).catch(() => '')
      c.check('An agent\'s change to a note still says so after Patchbay restarts', /Changed by Lead/.test(notice), notice)
      await again.click('.react-flow__node[data-id="board"] .note-edited-undo').catch(() => {})
      const undone = await L.waitFor('the note put back', async () => !(await L.doc(again)).nodes.find((n) => n.id === 'board').text.includes('changelog'), 3000).catch(() => false)
      c.check('Undo still works after the restart', undone)
    } finally {
      await reopened.quit().catch(() => {})
    }
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
