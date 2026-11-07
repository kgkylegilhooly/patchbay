'use strict'
// Run nodes end to end, with a server started through a parent script so it has a child process to leave behind.
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const lib = require('./lib.cjs')

const { check, finish } = lib.checker()
const shots = process.env.SHOTS

const portFree = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(true))
  })

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function main() {
  const hash = lib.settingsHash()
  const profile = lib.newProfile()
  const cwd = lib.workDir('run')
  const port = await freePort()
  fs.writeFileSync(path.join(cwd, 'server.cjs'), `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>console.log('LISTENING'))`)
  fs.writeFileSync(
    path.join(cwd, 'parent.cjs'),
    `const {spawn}=require('child_process');const c=spawn(process.execPath,['server.cjs'],{stdio:'inherit'});c.on('exit',k=>process.exit(k??1))`
  )
  const exe = process.argv.includes('--packaged') ? lib.packagedExe : undefined
  let app = await lib.launch({ profile, exe })
  let { page } = app
  const button = (id, which) => page.$(`.react-flow__node[data-id="${id}"] [data-run="${which}"]`)
  const label = (id) => page.$eval(`.react-flow__node[data-id="${id}"] .run-label`, (l) => l.textContent)
  const labelIs = (id, text) => lib.waitFor(`${id} to read ${text}`, async () => (await label(id)) === text, 20000)
  const attention = () => page.evaluate(() => window.patchbay.getAttention())
  const node = (id, command, x = 40) => ({ id, kind: 'run', title: id, x, y: 40, width: 560, height: 300, parentId: null, cwd, command })

  try {
    // Through the real menu.
    await page.mouse.click(760, 300, { button: 'right' })
    await page.waitForSelector('.menu-panel [data-cmd="new-run"]')
    if (shots) await page.screenshot({ path: path.join(shots, 'run-menu.png') })
    await page.click('.menu-panel [data-cmd="new-run"]')
    await page.waitForSelector('form[aria-label="New run command"]')
    const off = await page.$eval('form[aria-label="New run command"] .btn-solid', (b) => b.disabled)
    check('A run command with no command cannot be created', off)
    await page.type('form[aria-label="New run command"] [name="command"]', 'echo from-the-menu')
    await page.keyboard.press('Enter')
    const made = await lib.waitFor('the new node', async () => (await lib.doc(page)).nodes.find((n) => n.kind === 'run'), 8000)
    await lib.waitFor('its output', async () => (await lib.snapshot(page, made.id)).includes('from-the-menu'), 15000)
    await labelIs(made.id, 'Exited 0')
    check('A new run command starts straight away and reports its exit', true)
    check('A clean exit is nothing to look at', !(await attention()).includes(made.id))
    await page.evaluate((i) => window.patchbay.dispatch({ op: 'removeNodes', ids: [i] }), made.id)

    await lib.openNode(page, node('server', 'node parent.cjs'))
    await lib.waitFor('the server to listen', async () => !(await portFree(port)), 20000).catch(async (e) => {
      console.log('OUTPUT', JSON.stringify((await lib.snapshot(page, 'server')).slice(-600)), JSON.stringify(await page.evaluate(() => window.patchbay.getRuns())))
      throw e
    })
    await labelIs('server', 'Running')
    await lib.fitView(page)
    if (shots) await page.screenshot({ path: path.join(shots, 'run-running.png') })
    await (await button('server', 'stop')).click()
    await labelIs('server', 'Stopped')
    await lib.waitFor('the port to free', () => portFree(port), 8000)
    check('Stop frees the port of a child process', true)
    check('Stop is not shown as a failure', !(await attention()).includes('server') && !(await page.$('.run-label-failed')))

    await (await button('server', 'run')).click()
    await lib.waitFor('it to listen again', async () => !(await portFree(port)), 20000)
    const listening = async () => ((await lib.snapshot(page, 'server')).match(/LISTENING/g) ?? []).length
    const before = await listening()
    await (await button('server', 'restart')).click()
    await lib.waitFor('the new server to say so', async () => (await listening()) > before, 20000)
    await lib.sleep(500)
    check('Restart stops the old one and starts a new one, with no clash', (await label('server')) === 'Running' && !(await portFree(port)), await label('server'))
    const output = await lib.snapshot(page, 'server')
    check('Earlier output stays, with a divider', output.includes('--- run again ---'))

    // A real npm script, whose tree runs through sh and node.
    const npmPort = await freePort()
    fs.writeFileSync(path.join(cwd, 'server3.cjs'), `require('http').createServer((q,s)=>s.end('ok')).listen(${npmPort},'127.0.0.1')`)
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts: { dev: 'node server3.cjs' } }))
    await lib.openNode(page, node('npmdev', 'npm run dev', 1900))
    await lib.waitFor('npm run dev to listen', async () => !(await portFree(npmPort)), 30000)
    await lib.fitView(page)
    await (await button('npmdev', 'stop')).click()
    await lib.waitFor('its port to free', () => portFree(npmPort), 8000).then(
      () => check('Stop frees the port of a real npm run dev', true),
      (e) => check('Stop frees the port of a real npm run dev', false, e.message)
    )
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['npmdev'] }))

    // A command that prints nothing still has to restart.
    await lib.openNode(page, node('silent', 'node -e "setInterval(()=>{},1000)"', 1900))
    await labelIs('silent', 'Running')
    await lib.sleep(1500)
    const startedAt = () => page.evaluate(() => window.patchbay.getRuns().then((r) => r.silent.at))
    const firstRun = await startedAt()
    await page.evaluate(() => window.patchbay.restartNode('silent'))
    await lib.sleep(1500)
    check('Restart works on a running command that has printed nothing', (await startedAt()) !== firstRun)
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['silent'] }))

    // Through Git Bash's own sh, as an npm script runs, which breaks the Windows parent chain.
    const shellPort = await freePort()
    fs.writeFileSync(path.join(cwd, 'server2.cjs'), `require('http').createServer((q,s)=>s.end('ok')).listen(${shellPort},'127.0.0.1')`)
    await lib.openNode(page, node('viash', 'sh -c "node server2.cjs; echo ended"', 1280))
    await lib.waitFor('the sh server to listen', async () => !(await portFree(shellPort)), 20000)
    await lib.fitView(page)
    await (await button('viash', 'stop')).click()
    await lib.waitFor('the sh server to free', () => portFree(shellPort), 8000).then(
      () => check('Stop frees the port of a server started through sh', true),
      (e) => check('Stop frees the port of a server started through sh', false, e.message)
    )
    await page.evaluate(() => window.patchbay.dispatch({ op: 'removeNodes', ids: ['viash'] }))

    await lib.openNode(page, node('fails', 'exit 3', 660))
    await labelIs('fails', 'Exited 3')
    await lib.sleep(300)
    check('A failure shows in red', !!(await page.$('.react-flow__node[data-id="fails"] .run-label-failed')))
    check('And counts as something to look at', (await attention()).includes('fails'), await attention())
    await lib.sleep(300)
    if (shots) await page.screenshot({ path: path.join(shots, 'run-failed.png') })

    // Stop everything and quit with the server up, then reopen.
    check('The server is up before quitting', !(await portFree(port)))
    const code = await app.quit()
    check('Quit exits', code === 0, code)
    await lib.waitFor('the port to free after quitting', () => portFree(port), 8000)
    check('Quitting frees the port', true)

    app = await lib.launch({ profile, exe })
    page = app.page
    await lib.sleep(2500)
    check('Reopening does not start it again', await portFree(port))
    check('It waits at Run', (await label('server')) === 'Not running' && !!(await button('server', 'run')))
    const kept = (await lib.screen(page, 'server')).join('\n')
    check('It shows its last output', kept.includes('LISTENING'), kept.slice(0, 120))

    await lib.fitView(page)
    await (await button('server', 'run')).click()
    await lib.waitFor('it to listen', async () => !(await portFree(port)), 20000)
    const first = (await lib.doc(page)).activeProjectId
    await page.evaluate(() => window.patchbay.dispatch({ op: 'addProject', project: { id: 'other', name: 'Other', folder: '', viewport: { x: 0, y: 0, zoom: 1 } } }))
    await page.evaluate((id) => window.patchbay.dispatch({ op: 'removeProject', id, at: Date.now() }), first)
    await lib.waitFor('the port to free with the project closed', () => portFree(port), 10000)
    check('Closing the project frees the port', true)

    check('No errors in the page', app.problems.length === 0, app.problems)
    check('~/.claude/settings.json is unchanged', lib.settingsHash() === hash)
  } finally {
    await app.forceKill().catch(() => {})
    lib.cleanup(profile)
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
