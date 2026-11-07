'use strict'
// Milestone 4: a browser node an agent drives through the real patchbay command, typed into a real terminal node. The
// pages come from browsersite.cjs on loopback. No Claude runs, so it spends no quota.
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const { startSite } = require('./browsersite.cjs')

const c = L.checker()
U.watchdog(8 * 60_000)
const SENTINEL = 'Typed-SENTINEL-4471'

function seed(profile, cwd) {
  const term = (id, x) => ({ id, kind: 'terminal', title: id, x, y: 0, width: 520, height: 300, parentId: null, cwd, projectId: 'p1' })
  const doc = {
    version: 3,
    projects: [{ id: 'p1', name: 'Browser', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 0.8 },
    nodes: [term('agent', 0), term('stranger', 0)].map((n, i) => ({ ...n, y: i * 340 })),
    edges: [],
    closed: []
  }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
}

let seq = 0
/** Runs patchbay in a terminal node's own shell, so it has that node's identity, and returns what it printed. */
async function cli(page, cwd, node, args) {
  const out = `${cwd.replace(/\\/g, '/')}/out-${++seq}`
  await L.submit(page, node, `patchbay ${args} > ${out}.txt 2>&1; echo $? > ${out}.code`)
  await L.waitFor(`patchbay ${args.split(' ').slice(0, 2).join(' ')}`, () => fs.existsSync(`${out}.code`) && fs.readFileSync(`${out}.code`, 'utf8').trim() !== '', 45000, 200)
  const text = fs.readFileSync(`${out}.txt`, 'utf8')
  const code = Number(fs.readFileSync(`${out}.code`, 'utf8').trim())
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // A refusal is plain text.
  }
  return { code, text, json }
}

const refFor = (read, name) => read.json?.elements?.find((e) => e.name.includes(name))?.ref

/** Where a spot in page pixels is on screen, at whatever the canvas zoom is. */
async function screenPoint(page, nodeId, x, y) {
  return page.evaluate(
    (id, px, py) => {
      const view = document.querySelector(`.react-flow__node[data-id="${id}"] .browser-page`)
      const box = view.getBoundingClientRect()
      const scale = box.width / view.offsetWidth
      return { x: box.left + px * scale, y: box.top + py * scale, scale }
    },
    nodeId,
    x,
    y
  )
}

async function zoomTo(page, zoom) {
  await page.evaluate((z) => window.patchbay.dispatch({ op: 'setViewport', viewport: { x: 20, y: 20, zoom: z } }), zoom)
  // The view only follows a saved viewport on a project switch, so the dock's zoom buttons do the rest.
  const now = async () => (await page.$eval('.react-flow__viewport', (el) => new DOMMatrix(getComputedStyle(el).transform).a))
  for (let i = 0; i < 12 && Math.abs((await now()) - zoom) > 0.06; i++) {
    const cmd = (await now()) > zoom ? 'zoom-out' : 'zoom-in'
    await page.evaluate((k) => [...document.querySelectorAll(`[data-cmd="${k}"]`)].find((b) => b.closest('.dock'))?.click(), cmd)
    await L.sleep(300)
  }
  return now()
}

async function main() {
  const site = await startSite()
  const base = `http://127.0.0.1:${site.port}`
  const cwd = L.workDir('browser')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  seed(profile, cwd)
  let app = await L.launch({ profile })
  let page = app.page
  try {
    for (const id of ['agent', 'stranger']) await L.waitFor(`the ${id} shell`, async () => /\$/.test(await L.snapshot(page, id)), 30000)
    await L.sleep(1500)
    const control = JSON.parse(fs.readFileSync(path.join(profile, 'control', 'endpoint.json'), 'utf8')).port

    const opened = await cli(page, cwd, 'agent', `open-browser --url ${base}/page?probe=1&control=${control} --title Tester`.replace('&', '\\&'))
    const id = opened.json?.id
    c.check('open-browser opens a node and loads the page', opened.code === 0 && opened.json.showing && opened.json.loaded, opened.text.slice(0, 200))
    const node = (await L.doc(page)).nodes.find((n) => n.id === id)
    c.check('The node is a browser node opened by the agent', node?.kind === 'browser' && node.openedBy === 'agent')

    let read = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    c.check('read returns the text, marked untrusted', read.json?.untrusted === true && /untrusted/i.test(read.json.notice) && read.json.text.includes('count=0'))
    const add = refFor(read, 'Add one')
    const name = refFor(read, 'Your name')
    const pw = refFor(read, 'Password')
    c.check('read lists interactive elements with refs', !!add && !!name && !!pw, read.json?.elements?.slice(0, 5))
    c.check('A password field is flagged and its value never listed', read.json.elements.find((e) => e.ref === pw)?.sensitive === true && !('value' in read.json.elements.find((e) => e.ref === pw)))
    await L.waitFor('the in-page probe', () => site.reports.length > 0, 10000).catch(() => {})
    const probe = site.reports[0] ?? ''
    c.check('From inside the page: no patchbay, bridge, require, process or electron', /patchbay=undefined bridge=undefined require=undefined process=undefined electron=undefined ipcRenderer=undefined/.test(probe), probe)
    c.check('From inside the page: not framed by the app, and the control endpoint gives nothing', / top=self /.test(probe) && /rpc=(failed|status 40[14])/.test(probe), probe)

    const clicked = await cli(page, cwd, 'agent', `browser click --node ${id} --ref ${add}`)
    read = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    c.check('click presses the button', clicked.code === 0 && read.json.text.includes('count=1'), clicked.text.slice(0, 200))
    c.check('Refs stay the same between reads', refFor(read, 'Add one') === add)

    const typed = await cli(page, cwd, 'agent', `browser type --node ${id} --ref ${name} --text ${SENTINEL}`)
    read = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    c.check('type fills the field, and the reply does not echo the text', typed.code === 0 && !typed.text.includes(SENTINEL) && read.json.elements.find((e) => e.ref === name)?.value === SENTINEL, typed.text.slice(0, 200))
    const pwTyped = await cli(page, cwd, 'agent', `browser type --node ${id} --ref ${pw} --text hunter2`)
    c.check('Typing into a password field is refused', pwTyped.code === 1 && /password/.test(pwTyped.text), pwTyped.text.trim())

    const scrolled = await cli(page, cwd, 'agent', `browser scroll --node ${id} --by 1500`)
    const up = await cli(page, cwd, 'agent', `browser scroll --node ${id} --to top`)
    c.check('scroll moves the page and back', scrolled.json?.scrollY >= 1400 && up.json?.scrollY === 0, [scrolled.json, up.json])

    const shotReply = await cli(page, cwd, 'agent', `browser screenshot --node ${id}`)
    const shotFile = shotReply.json?.path
    const isPng = !!shotFile && fs.existsSync(shotFile) && fs.readFileSync(shotFile).subarray(1, 4).toString() === 'PNG'
    c.check('screenshot writes a PNG under app data', isPng && path.resolve(shotFile).startsWith(path.resolve(profile)), shotReply.text.slice(0, 200))
    if (isPng) fs.copyFileSync(shotFile, path.join(L.root, 'docs', 'acceptance', 'browser-agent-screenshot.png'))

    const nav = await cli(page, cwd, 'agent', `browser navigate --node ${id} --url ${base}/two`)
    const back = await cli(page, cwd, 'agent', `browser back --node ${id}`)
    const fwd = await cli(page, cwd, 'agent', `browser forward --node ${id}`)
    const reload = await cli(page, cwd, 'agent', `browser reload --node ${id}`)
    c.check('navigate, back, forward and reload work', nav.json?.url === `${base}/two` && back.json?.url.startsWith(`${base}/page`) && fwd.json?.url === `${base}/two` && reload.json?.moved === true, [nav.json?.url, back.json?.url, fwd.json?.url])
    c.check('A stale ref after navigating is refused, not guessed', (await cli(page, cwd, 'agent', `browser click --node ${id} --ref ${add}`)).code === 1)

    const file = await cli(page, cwd, 'agent', `browser navigate --node ${id} --url file:///C:/Windows/win.ini`)
    const custom = await cli(page, cwd, 'agent', `browser navigate --node ${id} --url mycustom-pb://launch`)
    const js = await cli(page, cwd, 'agent', `browser navigate --node ${id} --url 'javascript:alert(1)'`)
    c.check('An agent navigating to file://, a custom protocol or javascript: is refused', [file, custom, js].every((r) => r.code === 1 && /only open http/.test(r.text)), [file.text, custom.text, js.text].map((t) => t.trim()))

    // The page itself tries to leave: a custom protocol, a file, then a pop-up.
    await cli(page, cwd, 'agent', `browser navigate --node ${id} --url ${base}/escape`)
    await L.sleep(1500)
    const after = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    const notice = await page.evaluate(() => document.querySelector('[data-browser-notice]')?.textContent ?? '')
    c.check('A page sending itself to a custom protocol or a file stays on the web', /^http:\/\/127\.0\.0\.1/.test(after.json?.url ?? ''), after.json?.url)
    c.check('Its pop-up opened in the same node instead of a window', after.json?.url === `${base}/two` && (await app.browser.pages()).length === 1, after.json?.url)
    c.check("The node says what it refused", /mycustom-pb|file|another program/.test(notice), notice)

    // A webview asking for any other storage, or for a preload, doesn't attach.
    const rogue = await page.evaluate(async (url) => {
      const tries = [{ partition: 'persist:rogue' }, {}]
      const results = []
      for (const attrs of tries) {
        const v = document.createElement('webview')
        for (const [k, val] of Object.entries(attrs)) v.setAttribute(k, val)
        v.setAttribute('src', url)
        let attached = false
        v.addEventListener('did-attach', () => (attached = true))
        document.body.appendChild(v)
        await new Promise((r) => setTimeout(r, 2500))
        results.push(attached)
        v.remove()
      }
      return results
    }, `${base}/two`)
    c.check('A webview on any other partition, or the app\'s own, is refused', rogue.every((a) => a === false), rogue)

    const strangerRead = await cli(page, cwd, 'stranger', `browser read --node ${id}`)
    const strangerClick = await cli(page, cwd, 'stranger', `browser click --node ${id} --ref e1`)
    c.check('A node that neither opened nor is linked to the browser is refused', strangerRead.code === 1 && strangerClick.code === 1 && /isn't linked to you/.test(strangerRead.text), strangerRead.text.trim())

    await cli(page, cwd, 'agent', `browser navigate --node ${id} --url ${base}/page`)
    await L.fitView(page)
    await L.shot(page, 'browser-after-driving')
    await page.click(`${U.nodeSel(id)} [data-browser="take-control"]`)
    await L.sleep(500)
    const heldDoc = (await L.doc(page)).nodes.find((n) => n.id === id)
    const heldRead = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    const heldClose = await cli(page, cwd, 'agent', `close --node ${id}`)
    c.check('Take control is saved on the node', heldDoc.held === true)
    c.check('After Take control, agent verbs are refused', heldRead.code === 1 && /taken control/.test(heldRead.text) && heldClose.code === 1, heldRead.text.trim())
    await L.shot(page, 'browser-after-take-control')
    await page.click(`${U.nodeSel(id)} [data-browser="hand-back"]`)
    await L.sleep(500)
    c.check('Hand back lets the agent drive again', (await cli(page, cwd, 'agent', `browser read --node ${id}`)).code === 0)

    // Zoom: a real mouse click at the button's place on screen, and an agent click, at several zoom levels.
    for (const zoom of [0.5, 1.4]) {
      const actual = await zoomTo(page, zoom)
      await page.evaluate((nid) => document.querySelector(`.react-flow__node[data-id="${nid}"]`).scrollIntoView(), id)
      const before = Number(/count=(\d+)/.exec((await cli(page, cwd, 'agent', `browser read --node ${id}`)).json.text)[1])
      const at = await screenPoint(page, id, 80, 40)
      const onPage = await page.evaluate((x, y) => document.elementFromPoint(x, y)?.tagName, at.x, at.y)
      await page.mouse.click(at.x, at.y)
      await L.sleep(400)
      const agentRef = refFor(await cli(page, cwd, 'agent', `browser read --node ${id}`), 'Add one')
      await cli(page, cwd, 'agent', `browser click --node ${id} --ref ${agentRef}`)
      const after = Number(/count=(\d+)/.exec((await cli(page, cwd, 'agent', `browser read --node ${id}`)).json.text)[1])
      c.check(`At zoom ${actual.toFixed(2)}, a real click on screen and an agent click both land on the button`, onPage === 'WEBVIEW' && after === before + 2, { before, after, onPage, scale: at.scale })
      await L.shot(page, `browser-after-zoom-${String(zoom).replace('.', '')}`)
    }

    // Storage: the agent's node and a node the person opens keep separate stores, and both survive a restart.
    await zoomTo(page, 0.6)
    await L.fitView(page)
    await cli(page, cwd, 'agent', `browser navigate --node ${id} --url ${base}/store?v=agent-value`)
    await page.evaluate((url) => window.patchbay.dispatch({ op: 'addNode', node: { id: 'mine', kind: 'browser', title: 'Mine', x: 600, y: 700, width: 600, height: 360, parentId: null, url } }), `${base}/show`)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'addEdge', edge: { id: 'l1', from: 'agent', to: 'mine', kind: 'link' } }))
    const mineRead = await cli(page, cwd, 'agent', `browser read --node mine`)
    c.check('A linked node the person opened can be read', mineRead.code === 0, mineRead.text.slice(0, 120))
    c.check('The person\'s browser storage is not the agent\'s', /ls=none/.test(mineRead.json?.text ?? ''), mineRead.json?.text)
    await cli(page, cwd, 'agent', `browser navigate --node mine --url ${base}/store?v=person-value`)
    await L.sleep(500)
    await app.quit()

    app = await L.launch({ profile })
    page = app.page
    for (const n of ['agent', 'stranger']) await L.waitFor(`the ${n} shell again`, async () => /\$/.test(await L.snapshot(page, n)), 30000)
    await L.sleep(1500)
    const kept = (await L.doc(page)).nodes.find((n) => n.id === id)
    c.check('The URL was kept across the restart', kept?.url === `${base}/store?v=agent-value`, kept?.url)
    await cli(page, cwd, 'agent', `browser navigate --node ${id} --url ${base}/show`)
    await cli(page, cwd, 'agent', `browser navigate --node mine --url ${base}/show`)
    const agentShow = (await cli(page, cwd, 'agent', `browser read --node ${id}`)).json?.text
    const mineShow = (await cli(page, cwd, 'agent', `browser read --node mine`)).json?.text
    c.check('Each store survived the restart, still separate', /ls=agent-value/.test(agentShow) && /ls=person-value/.test(mineShow), [agentShow, mineShow])
    await L.fitView(page)
    await L.shot(page, 'browser-after-relaunch')
    await app.quit()

    const leaks = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        // The terminal's own output holds the command it ran, as any terminal would.
        if (e.isDirectory()) {
          if (e.name !== 'scrollback') walk(full)
        } else if (fs.statSync(full).size < 50e6 && fs.readFileSync(full).includes(SENTINEL)) leaks.push(path.relative(profile, full))
      }
    }
    walk(profile)
    c.check('The typed text was written nowhere in app data outside the terminal\'s own output', leaks.length === 0, leaks)
    c.check('The browser stores live in their own partitions', fs.existsSync(path.join(profile, 'Partitions', 'patchbay-browser')) && fs.existsSync(path.join(profile, 'Partitions', 'patchbay-browser-agent')))
    c.check('No page errors in the app window', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    if (app.child.exitCode === null) await app.forceKill().catch(() => {})
    site.close()
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
