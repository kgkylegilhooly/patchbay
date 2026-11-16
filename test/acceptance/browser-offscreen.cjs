'use strict'
// A browser node an agent drives while it's out of view on the canvas, as on a real busy canvas, where the agent's new
// browser can open beyond the visible part. Clicks, typing and screenshots must still work. No Claude runs.
// Run: node test/acceptance/browser-offscreen.cjs [--packaged]
const fs = require('node:fs')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const { startSite } = require('./browsersite.cjs')

const c = L.checker()
U.watchdog(5 * 60_000)

let seq = 0
async function cli(page, cwd, node, args) {
  const out = `${cwd.replace(/\\/g, '/')}/out-${++seq}`
  await L.submit(page, node, `patchbay ${args} > ${out}.txt 2>&1; echo $? > ${out}.code`)
  await L.waitFor(`patchbay ${args.split(' ').slice(0, 2).join(' ')}`, () => fs.existsSync(`${out}.code`) && fs.readFileSync(`${out}.code`, 'utf8').trim() !== '', 60000, 200)
  const text = fs.readFileSync(`${out}.txt`, 'utf8')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { code: Number(fs.readFileSync(`${out}.code`, 'utf8').trim()), text, json }
}

async function main() {
  const site = await startSite()
  const base = `http://127.0.0.1:${site.port}`
  const cwd = L.workDir('browser-offscreen')
  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const doc = {
    version: 3,
    projects: [{ id: 'p1', name: 'Browser', folder: cwd, viewport: { x: 0, y: 0, zoom: 1 } }],
    activeProjectId: 'p1',
    viewport: { x: 20, y: 20, zoom: 0.8 },
    nodes: [{ id: 'agent', kind: 'terminal', title: 'agent', x: 0, y: 0, width: 520, height: 300, parentId: null, cwd, projectId: 'p1' }],
    edges: [],
    closed: []
  }
  fs.writeFileSync(path.join(profile, 'canvas.json'), JSON.stringify(doc))
  const app = await L.launch({ profile, exe: process.argv.includes('--packaged') ? L.packagedExe : undefined })
  const { page } = app
  try {
    await L.waitFor('the shell', async () => /\$/.test(await L.snapshot(page, 'agent')), 30000)
    await L.sleep(1500)
    const opened = await cli(page, cwd, 'agent', `open-browser --url ${base}/page --title Tester`)
    const id = opened.json?.id
    c.check('open-browser opens a node', opened.code === 0 && !!id, opened.text.slice(0, 200))
    // Far outside the visible part of the canvas.
    await page.evaluate((i) => window.patchbay.dispatch({ op: 'patchNode', id: i, patch: { x: 9000, y: 9000 } }), id)
    await L.sleep(1500)
    const where = await page.evaluate((i) => {
      const el = document.querySelector(`.react-flow__node[data-id="${i}"]`)
      if (!el) return 'not rendered'
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), top: Math.round(r.top), inView: r.left < innerWidth && r.top < innerHeight }
    }, id)
    c.check('The node is out of view', where !== 'not rendered' && !where.inView, where)

    let read = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    const add = read.json?.elements?.find((e) => e.name.includes('Add one'))?.ref
    c.check('read works out of view', !!add && read.json.text.includes('count=0'), read.text.slice(0, 200))
    const clicked = await cli(page, cwd, 'agent', `browser click --node ${id} --ref ${add}`)
    read = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    c.check('click works out of view', clicked.code === 0 && read.json?.text.includes('count=1'), { clicked: clicked.text.slice(0, 200), text: read.json?.text.slice(0, 120) })
    const name = read.json?.elements?.find((e) => e.name.includes('Your name'))?.ref
    const typed = await cli(page, cwd, 'agent', `browser type --node ${id} --ref ${name} --text hello --enter`)
    c.check('type with --enter works out of view', typed.code === 0, typed.text.slice(0, 200))
    const shot = await cli(page, cwd, 'agent', `browser screenshot --node ${id}`)
    c.check('screenshot works out of view', shot.code === 0 && fs.existsSync(shot.json?.path ?? ''), shot.text.slice(0, 200))
    // A form: the to-do page from real-world.cjs, fixed, where Add submits the form.
    const todo = require('node:http').createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(`<!doctype html><title>To-do</title><h1>My to-dos</h1><form id="add"><input id="item" aria-label="New to-do"><button>Add</button></form><ul id="list"></ul>
<script>document.getElementById('add').addEventListener('submit', (e) => { e.preventDefault(); const i = document.getElementById('item'); const li = document.createElement('li'); li.textContent = i.value; document.getElementById('list').appendChild(li); i.value = '' })</script>`)
    })
    await new Promise((r) => todo.listen(0, '127.0.0.1', r))
    await cli(page, cwd, 'agent', `browser navigate --node ${id} --url http://127.0.0.1:${todo.address().port}/`)
    let form = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    const field = form.json?.elements?.find((e) => e.tag === 'input')?.ref
    const button = form.json?.elements?.find((e) => e.tag === 'button')?.ref
    await cli(page, cwd, 'agent', `browser type --node ${id} --ref ${field} --text "buy milk" --clear`)
    const pressed = await cli(page, cwd, 'agent', `browser click --node ${id} --ref ${button}`)
    form = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    c.check('A click on a form button submits it out of view', form.json?.text.includes('buy milk'), { pressed: pressed.text.slice(0, 160), text: form.json?.text })
    await cli(page, cwd, 'agent', `browser type --node ${id} --ref ${field} --text "eggs" --enter`)
    form = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    c.check('Enter submits it out of view', form.json?.text.includes('eggs'), form.json?.text)
    // The same in view, to tell an out-of-view problem from a form problem.
    await page.evaluate((i) => window.patchbay.dispatch({ op: 'patchNode', id: i, patch: { x: 600, y: 0 } }), id)
    await L.sleep(800)
    await cli(page, cwd, 'agent', `browser navigate --node ${id} --url http://127.0.0.1:${todo.address().port}/`)
    form = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    await cli(page, cwd, 'agent', `browser type --node ${id} --ref ${form.json?.elements?.find((e) => e.tag === 'input')?.ref} --text "jam" --clear`)
    await cli(page, cwd, 'agent', `browser click --node ${id} --ref ${form.json?.elements?.find((e) => e.tag === 'button')?.ref}`)
    form = await cli(page, cwd, 'agent', `browser read --node ${id}`)
    c.check('A click on a form button submits it in view', form.json?.text.includes('jam'), form.json?.text)
    await page.evaluate((i) => window.patchbay.dispatch({ op: 'patchNode', id: i, patch: { x: 9000, y: 9000 } }), id)
    await L.sleep(800)
    todo.close()
    if (shot.json?.path && process.env.PB_SHOTS) fs.copyFileSync(shot.json.path, path.join(process.env.PB_SHOTS, 'offscreen-shot.png'))
    const after = await page.evaluate((i) => {
      const el = document.querySelector(`.react-flow__node[data-id="${i}"]`)
      const r = el.getBoundingClientRect()
      return { translate: el.style.translate, opacity: el.style.opacity, inView: r.left < innerWidth && r.top < innerHeight }
    }, id)
    c.check('The node is back where it was afterwards', !after.translate && !after.opacity && !after.inView, after)
    // A node in view isn't moved at all.
    await page.evaluate((i) => window.patchbay.dispatch({ op: 'patchNode', id: i, patch: { x: 600, y: 0 } }), id)
    await L.sleep(800)
    const inView = await cli(page, cwd, 'agent', `browser screenshot --node ${id}`)
    c.check('screenshot still works in view', inView.code === 0, inView.text.slice(0, 200))
    c.check('No page errors in the app window', app.problems.length === 0, app.problems.slice(0, 3))
  } finally {
    await app.quit().catch(() => {})
    site.close?.()
    L.cleanup(profile)
  }
  c.finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
