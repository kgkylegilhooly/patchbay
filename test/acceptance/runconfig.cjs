'use strict'
// Run nodes from .vscode/launch.json on the real app. Run: node test/acceptance/runconfig.cjs (after npm run build)
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const L = require('./lib.cjs')
const U = require('./uilib.cjs')
const { rightClickCanvas } = require('./scenes.cjs')

const c = L.checker()
U.watchdog(5 * 60_000)
const step = U.stepper(c.check)

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.on('connect', () => {
      s.destroy()
      resolve(false)
    })
    s.on('error', () => resolve(true))
  })
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function main() {
  const cwd = L.workDir('runconfig')
  const [port, port2] = [await freePort(), await freePort()]
  const marker = path.join(cwd, 'ran.txt')
  fs.writeFileSync(path.join(cwd, 'server.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('LISTENING', process.argv[2], process.env.GREETING))`)
  fs.mkdirSync(path.join(cwd, '.vscode'))
  const launchJson = (extra = {}) => `{
    // Comments and trailing commas, as VS Code writes them.
    "version": "0.2.0",
    "configurations": [
      { "type": "node", "request": "launch", "name": "Server", "program": "\${workspaceFolder}/server.cjs", "args": ["${port}"], "env": { "GREETING": "hello-from-env" }, ${extra.server ?? ''} },
      { "type": "node", "request": "launch", "name": "Second", "program": "server.cjs", "args": ["${port2}"] },
      { "type": "node", "request": "launch", "name": "Needs a task", "program": "server.cjs", "preLaunchTask": "build" },
      { "type": "python", "request": "launch", "name": "Python", "program": "a.py" },
    ],
    "compounds": [{ "name": "Both", "configurations": ["Server", "Second"] }],
  }`
  fs.writeFileSync(path.join(cwd, '.vscode', 'launch.json'), launchJson())

  const profile = L.newProfile({ notifications: 'off', sound: 'off' })
  const app = await L.launch({ profile })
  const page = app.page
  const label = (id) => page.$eval(`.react-flow__node[data-id="${id}"] .run-label`, (l) => l.textContent)
  // A DOM click, so a cable or frame drawn over the button can't take it.
  const press = (id, which) => page.$eval(`.react-flow__node[data-id="${id}"] [data-run="${which}"]`, (b) => b.click())
  const runNodes = async () => (await L.doc(page)).nodes.filter((n) => n.kind === 'run')
  const openForm = async () => {
    await rightClickCanvas(page)
    await page.waitForSelector('.menu-panel [data-cmd="new-run-config"]')
    await page.click('.menu-panel [data-cmd="new-run-config"]')
    await page.waitForSelector('form[aria-label="New run configuration"] .launch-item')
  }
  const item = (name) => `form[aria-label="New run configuration"] [data-launch="${name}"]`
  try {
    await step('reading', async () => {
      const doc = await L.doc(page)
      await page.evaluate((id, folder) => window.patchbay.dispatch({ op: 'patchProject', id, patch: { folder } }), doc.activeProjectId, cwd)
      await openForm()
      const rows = await page.$$eval('form[aria-label="New run configuration"] .launch-item', (ls) => ls.map((l) => ({ name: l.dataset.launch, ok: l.dataset.runnable, text: l.textContent })))
      c.check('Every configuration and compound is listed', rows.map((r) => r.name).join() === 'Server,Second,Needs a task,Python,Both', rows.map((r) => r.name))
      const row = (n) => rows.find((r) => r.name === n)
      c.check('A runnable one shows what it will run', row('Server').ok === 'yes' && row('Server').text.includes(`server.cjs ${port}`), row('Server').text)
      c.check('One with a preLaunchTask is disabled, with the reason', row('Needs a task').ok === 'no' && /preLaunchTask/.test(row('Needs a task').text))
      c.check('A non-node one is disabled, with the reason', row('Python').ok === 'no' && /Only node/.test(row('Python').text))
      c.check('A disabled one cannot be chosen', await page.$eval(`${item('Python')} input`, (i) => i.disabled))
      c.check('Reading launch.json ran nothing', !fs.existsSync(marker))
      if (process.env.SHOTS) await L.shot(page, 'runconfig-accept-picker')
    })

    let id
    await step('run and stop', async () => {
      await page.click(`${item('Server')} input`)
      await page.click('form[aria-label="New run configuration"] .btn-solid')
      id = await L.waitFor('the run node', async () => (await runNodes())[0]?.id, 5000)
      await L.waitFor('the server to listen', async () => !(await portFree(port)), 20000)
      // The port can be open a moment before the line it prints reaches the scrollback.
      const printed = (s) => /LISTENING \d+ hello-from-env/.test(s)
      const out = await L.waitFor('its output', async () => { const s = await L.snapshot(page, id); return printed(s) && s }, 5000).catch(() => L.snapshot(page, id))
      c.check('A launch.json configuration runs, with its args and env', /LISTENING \d+ hello-from-env/.test(out), out.slice(-200))
      c.check('It is marked as from launch.json', (await runNodes())[0].launch?.name === 'Server')
      await L.fitView(page)
      await L.waitFor('Running', async () => (await label(id)) === 'Running', 5000)
      await press(id, 'stop')
      await L.waitFor('the port to free', () => portFree(port), 10000)
      await L.waitFor('Stopped', async () => (await label(id)) === 'Stopped', 5000)
      c.check('Stop ends it and frees its port', true)
      await press(id, 'run')
      await L.waitFor('it to listen again', async () => !(await portFree(port)), 20000)
      const listening = async () => ((await L.snapshot(page, id)).match(/LISTENING/g) ?? []).length
      const before = await listening()
      await press(id, 'restart')
      const restarted = await L.waitFor('the restarted server to listen', async () => (await listening()) > before && !(await portFree(port)), 20000).catch(() => false)
      c.check('Run and Restart work as for any run node', restarted && (await label(id)) === 'Running', { label: await label(id), before, now: await listening() })
      if (process.env.SHOTS) await L.shot(page, 'runconfig-accept-running')
      await press(id, 'stop')
      await L.waitFor('the port to free again', () => portFree(port), 10000)
      await L.waitFor('Stopped again', async () => (await label(id)) === 'Stopped', 5000)
    })

    await step('read again on each run', async () => {
      fs.writeFileSync(path.join(cwd, '.vscode', 'launch.json'), launchJson({ server: '"preLaunchTask": "build",' }))
      await press(id, 'run')
      await page.waitForSelector(`.react-flow__node[data-id="${id}"] [data-run-problem]`, { timeout: 5000 })
      const why = await page.$eval(`.react-flow__node[data-id="${id}"] [data-run-problem]`, (s) => s.textContent)
      await L.sleep(1500)
      c.check('A configuration that became unsupported is refused, not run from an old copy', /preLaunchTask/.test(why) && (await portFree(port)), { why, free: await portFree(port) })
      fs.writeFileSync(path.join(cwd, '.vscode', 'launch.json'), launchJson())
    })

    await step('compound', async () => {
      await openForm()
      await page.click(`${item('Both')} input`)
      await page.click('form[aria-label="New run configuration"] .btn-solid')
      await L.waitFor('both servers', async () => !(await portFree(port)) && !(await portFree(port2)), 25000)
      const doc = await L.doc(page)
      const group = doc.nodes.find((n) => n.kind === 'group' && n.title === 'Both')
      const members = doc.nodes.filter((n) => n.parentId === group?.id)
      c.check('A compound opens a group with a run node for each configuration', members.length === 2 && members.every((m) => m.kind === 'run' && m.launch), members.map((m) => m.title))
      await L.fitView(page)
      const labels = await Promise.all(members.map((m) => label(m.id)))
      c.check('Each shows its own state', labels.every((l) => l === 'Running'), labels)
      if (process.env.SHOTS) await L.shot(page, 'runconfig-accept-compound')
      await press(members[0].id, 'stop')
      await L.waitFor('the first to stop', () => portFree(port), 10000)
      c.check('Stopping one leaves the other running', !(await portFree(port2)) && (await label(members[1].id)) === 'Running')
    })

    c.check('No errors in the page', app.problems.length === 0, app.problems)
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
